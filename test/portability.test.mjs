import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {zipSync,strToU8} from 'fflate';
import {openDatabase,migrate,readiness} from '../server/database.mjs';
import {configuration} from '../server/config.mjs';
import {authenticate,passwordHash,tokenHash,trustedRequest,authRoute} from '../server/auth.mjs';
import {workspace,apply} from './fixtures/snapshot-workspace.mjs';
import {McpStore} from '../db/mcp-store.ts';
import {prepareStoredRecord,readStoredRecord,sha256} from '../db/workspace-records.ts';
import {captureArchive,encodeArchive,decodeArchive,archiveWorkspace,validateWorkspace} from '../lib/workspace-archive.ts';
import {importArchive,previewArchive} from '../db/archive-store.ts';
import {callTool} from '../lib/mcp/service.ts';
const directory=await mkdtemp(join(tmpdir(),'ww-portability-'));
const sqlite=async name=>{const db=await openDatabase({profile:'local',sqlitePath:join(directory,name+'.sqlite')},{create:true});await migrate(db);return db;};
const compressed=async a=>new Uint8Array(await new Response(encodeArchive(a)).arrayBuffer());
const decode=async a=>decodeArchive(new Blob([a]).stream());
const databases=[];
test.after(async()=>{for(const db of databases)await db.close?.();await rm(directory,{recursive:true,force:true});});

test('configuration fails closed without exposing secrets',()=>{
  assert.equal(configuration({}).profile,'local');
  for(const env of [{WW_HOST:'0.0.0.0'},{WW_AUTH:'accounts'},{WW_SQLITE_PATH:':memory:'},{WW_PROFILE:'self-hosted'},{WW_PROFILE:'bad'},{WW_PORT:'0'},{WW_TRUST_PROXY:'true'}])assert.throws(()=>configuration(env));
  assert.throws(()=>configuration({WW_PROFILE:'self-hosted',WW_PUBLIC_URL:'https://ww.example',WW_DATABASE_URL:'postgres://secret:password@host/db?sslmode=disable'}),/WW_PG_TLS/);
});

test('missing/newer schemas and SQLite contention fail safely and recover without reset',async()=>{
  const path=join(directory,'locking.sqlite'),first=await openDatabase({profile:'local',sqlitePath:path},{create:true});databases.push(first);
  await assert.rejects(()=>readiness(first));await migrate(first);
  const other=await openDatabase({profile:'local',sqlitePath:path});databases.push(other);await first.exec('BEGIN IMMEDIATE');
  try{await assert.rejects(()=>other.prepare('SELECT id FROM workspaces').all(),e=>e.retryable===true);}finally{await first.exec('ROLLBACK');}
  await readiness(other);await first.prepare('INSERT INTO wonderworks_schema(version) VALUES(5)').run();await assert.rejects(()=>migrate(first),/newer/);await assert.rejects(()=>readiness(first),/incompatible/);
  await assert.rejects(()=>openDatabase({profile:'local',sqlitePath:'/dev/null/workspace.sqlite'},{create:true}));
});

test('standalone identities cannot be forged; browser sessions and bearer tokens revoke on the next request',async()=>{
  const db=await sqlite('auth');databases.push(db);
  const path=join(directory,'accounts.json'),token='a'.repeat(40),user={id:'alice',email:'alice@example.test',allowed:true,password:passwordHash('long-test-password'),tokens:[tokenHash(token)]};
  await writeFile(path,JSON.stringify({users:[user]}),{mode:0o600});const config={auth:'accounts',accountsFile:path,baseUrl:'https://ww.example',sessionSecret:'s'.repeat(40)};
  const forged=new Request(config.baseUrl+'/api/workspace',{headers:{'oai-authenticated-user-id':'alice','oai-authenticated-user-email':'alice@example.test','x-forwarded-host':'localhost','oai-sites-authorization':'bypass'}});
  assert.equal((await authenticate(config,forged,'127.0.0.1')).status,401);
  const cleaned=trustedRequest(forged,null);assert.equal(cleaned.headers.get('oai-authenticated-user-id'),null);assert.equal(cleaned.headers.get('x-forwarded-host'),null);
  const authorized=new Request(config.baseUrl+'/mcp',{headers:{Authorization:'Bearer '+token}});assert.equal((await authenticate(config,authorized,'1.2.3.4')).user.id,'alice');
  const login=await authRoute(config,new Request(config.baseUrl+'/login',{method:'POST',headers:{Origin:config.baseUrl},body:new URLSearchParams({id:'alice',password:'long-test-password'})}),'1.2.3.4',db);assert.equal(login.status,303);
  const cookie=login.headers.get('set-cookie').split(';')[0],session=new Request(config.baseUrl,{headers:{Cookie:cookie}});assert.equal((await authenticate(config,session,'1.2.3.4',db)).user.id,'alice');
  user.allowed=false;await writeFile(path,JSON.stringify({users:[user]}));assert.equal((await authenticate(config,authorized,'1.2.3.4')).status,403);assert.equal((await authenticate(config,session,'1.2.3.4',db)).status,403);
  user.allowed=true;await writeFile(path,JSON.stringify({users:[user]}));await authRoute(config,new Request(config.baseUrl+'/signout-with-chatgpt',{method:'POST',headers:{Cookie:cookie,Origin:config.baseUrl}}),'1.2.3.4',db);assert.equal((await authenticate(config,session,'1.2.3.4',db)).status,401);
  user.allowed=true;user.tokens=[];user.password=passwordHash('rotated-test-password');await writeFile(path,JSON.stringify({users:[user]}));assert.equal((await authenticate(config,authorized,'1.2.3.4')).status,401);assert.equal((await authenticate(config,session,'1.2.3.4',db)).status,401);
  assert.equal((await authenticate({auth:'local',baseUrl:'http://127.0.0.1:3000'},new Request('http://127.0.0.1:3000'),'10.0.0.1')).status,403);
});

test('SQLite repeatable migration, restart replay, stale writes, atomic rollback and archive transfer',async t=>{
  let db=await sqlite('source');databases.push(db);await migrate(db);await readiness(db);
  const doc=workspace('portable-source');apply(doc);doc.future_field={missing:null,numbers:[0,false,'漢字 🌍']};
  doc.requirements[0].description='Unicode λ 漢字 🌍 '.repeat(1000);doc.version=4;
  const stored=await prepareStoredRecord(db,doc.id,doc);await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(doc.id,stored.data,doc.version).run();
  const args={project_id:doc.id,expected_workspace_version:4,idempotency_key:'portable-durable-retry',title:'Pending after restart',description:''},actor={id:'portable-actor'};
  const result=await callTool(new McpStore(db),'create_proposal',args,actor,'portability-test');
  await db.close();databases.splice(databases.indexOf(db),1);db=await sqlite('source');databases.push(db);
  assert.deepEqual(await callTool(new McpStore(db),'create_proposal',args,actor,'restart'),result);
  await assert.rejects(()=>callTool(new McpStore(db),'create_proposal',{...args,idempotency_key:'stale-different-key'},actor,'stale'),{code:'CONFLICT'});
  const next={...args,expected_workspace_version:5,idempotency_key:'atomic-failure-retry'};
  await db.exec("CREATE TRIGGER fail_commit BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'injected'); END;");
  await assert.rejects(()=>callTool(new McpStore(db),'create_proposal',next,actor,'failed'));
  assert.equal((await new McpStore(db).read(doc.id)).version,5);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM mcp_receipts').first()).n,1);
  await db.exec('DROP TRIGGER fail_commit');
  const before=await new McpStore(db).read(doc.id),archive=await captureArchive(db,'all'),zip=await compressed(archive),restored=await decode(zip);
  assert.deepEqual(archiveWorkspace(restored,restored.manifest.projects[0]),before);
  assert.ok(zip.length<JSON.stringify(before).length);assert.equal((await new McpStore(db).read(doc.id)).version,5);
  const target=await sqlite('target');databases.push(target);
  const imported=await importArchive(target,restored,[{id:doc.id,mode:'restore'}],'operator','restore-original-operation');
  assert.deepEqual(await new McpStore(target).read(doc.id),before);
  assert.deepEqual(await callTool(new McpStore(target),'create_proposal',args,actor,'after-transfer'),result);
  await assert.rejects(()=>callTool(new McpStore(target),'create_proposal',args,{id:'different-actor'},'wrong-scope'),{code:'CONFLICT'});
  assert.deepEqual(await importArchive(target,restored,[{id:doc.id,mode:'restore'}],'operator','restore-original-operation'),imported);
  assert.equal((await previewArchive(target,restored)).projects[0].conflict,true);
  const copy=await importArchive(target,restored,[{id:doc.id,mode:'copy'}],'operator','copy-original-operation');
  const copied=await new McpStore(target).read(copy.projects[0].id);assert.deepEqual({...copied,id:doc.id},before);
  assert.equal((await target.prepare('SELECT COUNT(*) AS n FROM mcp_receipts WHERE project=?').bind(copied.id).first()).n,0);
  await assert.rejects(()=>importArchive(target,restored,[{id:doc.id,mode:'restore'}],'operator','conflicting-operation'));
  const aborted=new AbortController();aborted.abort();await assert.rejects(()=>importArchive(target,restored,[{id:doc.id,mode:'copy'}],'operator','cancelled-operation',aborted.signal));assert.equal((await new McpStore(target).list()).length,2);
  await target.exec("CREATE TRIGGER fail_import BEFORE INSERT ON workspace_provenance BEGIN SELECT RAISE(ABORT,'injected'); END;");
  await assert.rejects(()=>importArchive(target,restored,[{id:doc.id,mode:'copy'}],'operator','failed-import-operation'));assert.equal((await new McpStore(target).list()).length,2);await target.exec('DROP TRIGGER fail_import');
  const retry=await importArchive(target,restored,[{id:doc.id,mode:'copy'}],'operator','failed-import-operation');assert.equal((await new McpStore(target).list()).length,3);assert.equal(retry.projects.length,1);
  await t.test('ZIP integrity, version, path, truncation and expansion rejection',async()=>{
    await assert.rejects(()=>decode(zip.subarray(0,zip.length-1)));
    const entries={'manifest.json':strToU8(JSON.stringify({...archive.manifest,version:99})),...Object.fromEntries([...archive.records].map(([h,s])=>['records/'+h+'.json',strToU8(s)]))};
    await assert.rejects(()=>decode(zipSync(entries)));
    await assert.rejects(()=>decode(zipSync({'../escape':strToU8('{}')})));
    await assert.rejects(()=>decode(zipSync({'manifest.json':strToU8('x'.repeat(2*1024*1024+1))})));
    const corrupt=structuredClone(archive.manifest);corrupt.records[0].hash='f'.repeat(64);entries['manifest.json']=strToU8(JSON.stringify(corrupt));await assert.rejects(()=>decode(zipSync(entries)));
    const invalid=structuredClone(before);invalid.requirements[0].links=[invalid.requirements[0].id];assert.throws(()=>validateWorkspace(invalid),/cycle/);
  });
});

test('D1 ↔ SQLite complete transfer preserves frozen history and retry scope',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'portable-d1'}});
  try{const d1=await mf.getD1Database('DB');for(const f of ['0000_graceful_terror','0001_lowly_talos','0002_clammy_wasp','0003_workspace_portability'])for(const sql of (await readFile(new URL('../drizzle/'+f+'.sql',import.meta.url),'utf8')).split('--> statement-breakpoint'))await d1.prepare(sql).run();
    const doc=workspace('d1-source-'+crypto.randomUUID());apply(doc);await d1.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(doc.id,JSON.stringify(doc),doc.version).run();
    const args={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:'d1-transfer-receipt',title:'Cross-backend retry receipt',description:''},actor={id:'cross-backend-actor'};
    const receipt=await callTool(new McpStore(d1),'create_proposal',args,actor,'before-transfer');
    const a=await decode(await compressed(await captureArchive(d1,'all'))),sq=await sqlite('from-d1');databases.push(sq);
    await importArchive(sq,a,[{id:doc.id,mode:'restore'}],'migration-operator','d1-to-sqlite-operation');assert.deepEqual(await new McpStore(sq).read(doc.id),await new McpStore(d1).read(doc.id));
    const back=await decode(await compressed(await captureArchive(sq,'all'))),copy=await importArchive(d1,back,[{id:doc.id,mode:'copy'}],'migration-operator','sqlite-to-d1-operation');assert.deepEqual({...await new McpStore(d1).read(copy.projects[0].id),id:doc.id},await new McpStore(sq).read(doc.id));
    if(process.env.WW_TEST_POSTGRES_URL){const pg=await openDatabase({profile:'self-hosted',databaseUrl:process.env.WW_TEST_POSTGRES_URL,tls:'disable'});databases.push(pg);await migrate(pg);await importArchive(pg,a,[{id:doc.id,mode:'restore'}],'migration-operator','d1-pg-'+crypto.randomUUID());assert.deepEqual(await new McpStore(pg).read(doc.id),await new McpStore(d1).read(doc.id));assert.deepEqual(await callTool(new McpStore(pg),'create_proposal',args,actor,'after-transfer'),receipt);
      const reverse=await decode(await compressed(await captureArchive(pg,doc.id))),newCopy=await importArchive(d1,reverse,[{id:doc.id,mode:'copy'}],'migration-operator','pg-d1-'+crypto.randomUUID());assert.deepEqual({...await new McpStore(d1).read(newCopy.projects[0].id),id:doc.id},await new McpStore(pg).read(doc.id));}
  }finally{await mf.dispose();}
});

test('large incompressible payload, multiple projects, legacy absence and cancellation remain bounded',async()=>{
  const db=await sqlite('large');databases.push(db);const doc=workspace('large-source');doc.future_blob=randomBytes(2*1024*1024).toString('base64');delete doc.requirements[0].tags;
  const stored=await prepareStoredRecord(db,doc.id,doc);await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(doc.id,stored.data,doc.version).run();
  const other=workspace('second-source');await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(other.id,JSON.stringify(other),other.version).run();
  const a=await captureArchive(db,'all'),zip=await compressed(a);assert.ok(zip.length>2*1024*1024);const decoded=await decode(zip);assert.equal(decoded.manifest.projects.length,2);assert.deepEqual(archiveWorkspace(decoded,decoded.manifest.projects.find(p=>p.id===doc.id)),doc);
  const abort=new AbortController();abort.abort();await assert.rejects(()=>decodeArchive(new Blob([zip]).stream(),abort.signal));
  const copied=await sqlite('large-target');databases.push(copied);await importArchive(copied,decoded,a.manifest.projects.map(p=>({id:p.id,mode:'restore'})),'large-operator','large-atomic-batch');assert.equal((await new McpStore(copied).list()).length,2);assert.equal((await new McpStore(copied).read(doc.id)).future_blob,doc.future_blob);
});

test('PostgreSQL independent pools, transactional receipts, restart and SQLite ↔ PostgreSQL transfer',{skip:!process.env.WW_TEST_POSTGRES_URL},async()=>{
  const config={profile:'self-hosted',databaseUrl:process.env.WW_TEST_POSTGRES_URL,tls:'disable'},a=await openDatabase(config),b=await openDatabase(config);databases.push(a,b);await migrate(a);await migrate(b);
  const source=await sqlite('postgres-source');databases.push(source);const doc=workspace('postgres-'+crypto.randomUUID());apply(doc);await source.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(doc.id,JSON.stringify(doc),doc.version).run();
  const archive=await decode(await compressed(await captureArchive(source,'all')));await importArchive(a,archive,[{id:doc.id,mode:'restore'}],'postgres-operator','postgres-restore-'+crypto.randomUUID());
  assert.deepEqual(await new McpStore(a).read(doc.id),await new McpStore(source).read(doc.id));
  const args={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:'concurrent-postgres-key',title:'Concurrent PostgreSQL mutation',description:''},actor={id:'pg-actor'};
  const results=await Promise.all([callTool(new McpStore(a),'create_proposal',args,actor,'a'),callTool(new McpStore(b),'create_proposal',args,actor,'b')]);assert.deepEqual(results[0],results[1]);assert.equal((await new McpStore(a).read(doc.id)).version,doc.version+1);
  await assert.rejects(()=>callTool(new McpStore(b),'create_proposal',{...args,idempotency_key:'different-stale-key'},actor,'stale'),{code:'CONFLICT'});
  const race=await Promise.allSettled([a,b].map((db,i)=>callTool(new McpStore(db),'create_proposal',{...args,expected_workspace_version:doc.version+1,idempotency_key:'competing-key-'+i},actor,'competing-'+i)));assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.find(r=>r.status==='rejected').reason.code,'CONFLICT');
  const before=await new McpStore(a).read(doc.id),receipts=(await a.prepare('SELECT COUNT(*) AS n FROM mcp_receipts WHERE project=?').bind(doc.id).first()).n;
  await a.exec(`CREATE OR REPLACE FUNCTION ww_test_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${doc.id}' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER ww_test_failure BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION ww_test_abort();`);
  try{await assert.rejects(()=>callTool(new McpStore(b),'create_proposal',{...args,expected_workspace_version:before.version,idempotency_key:'pg-fault-key'},actor,'fault'));assert.deepEqual(await new McpStore(a).read(doc.id),before);assert.equal((await a.prepare('SELECT COUNT(*) AS n FROM mcp_receipts WHERE project=?').bind(doc.id).first()).n,receipts);}finally{await a.exec('DROP TRIGGER ww_test_failure ON workspaces; DROP FUNCTION ww_test_abort();');}
  const back=await decode(await compressed(await captureArchive(a,doc.id))),dest=await sqlite('from-postgres');databases.push(dest);await importArchive(dest,back,[{id:doc.id,mode:'restore'}],'postgres-operator','postgres-to-sqlite-key');assert.deepEqual(await new McpStore(dest).read(doc.id),await new McpStore(a).read(doc.id));assert.deepEqual(await callTool(new McpStore(dest),'create_proposal',args,actor,'replay'),results[0]);
});
