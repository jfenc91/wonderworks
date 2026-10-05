import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {buildGraph,prepareStoredRecord,readStoredRecord,prepareWorkspaceCommit,StoredRecordSession,migrateWorkspaceStorage,sha256} from '../db/workspace-records.ts';
import {encodeWorkspace} from '../db/workspace-codec.ts';
import {McpStore} from '../db/mcp-store.ts';
import {callTool} from '../lib/mcp/service.ts';
import {createProposal,editProposalRequirement,submitProposal,reviewProposal} from '../lib/workflow.ts';
import {captureRequirementHistory} from '../lib/requirement-history.ts';
const fixture=()=>({id:'records',name:'Preserved 👩🏽‍💻',prefix:'RC',version:7,requirementsVersion:3,sections:[{id:'s',title:'All data',description:''}],requirements:[{id:'RC-001',revision:4,section:'s',title:'Exact source',description:'  <literal> & é\n\t...',criteria:['Keep everything.'],priority:'High',status:'Approved',parameters:{flag:false,count:0,text:''},links:[]}],proposals:[],baselines:[],history:[],repositories:[],evidence:[],legacyExtra:{unknown:['field',null,true,0],empty:{}}});
async function harness(run){const dir=await mkdtemp(join(tmpdir(),'ww-records-'));const start=()=>new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'records'},d1Persist:dir});let mf=start();try{let db=await mf.getD1Database('DB');for(const name of ['0000_graceful_terror.sql','0001_lowly_talos.sql','0002_clammy_wasp.sql'])for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))await db.prepare(sql).run();await run(db,async()=>{await mf.dispose();mf=start();db=await mf.getD1Database('DB');return db;});}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}}
test('bounded records preserve large incompressible strings, unusual keys and array order',async()=>harness(async db=>{
 const value={name:'Unicode 👩🏽‍💻',source:randomBytes(1_100_000).toString('hex'),ordered:Array.from({length:1000},(_,i)=>({i,text:'item '+i})),['x'.repeat(70000)]:'long key',...JSON.parse('{"__proto__":{"safe":true}}')};
 const stored=await prepareStoredRecord(db,'p',value);assert.deepEqual(await readStoredRecord(db,'p',stored.data),value);
 assert.ok((await db.prepare('SELECT max(length(CAST(data AS BLOB))) n FROM workspace_records').first()).n<=65536);
 await assert.rejects(()=>readStoredRecord(db,'different-project',stored.data),/Missing/);
 const again=await prepareStoredRecord(db,'p',value);assert.equal(again.newRecords,0);
 const graph=await buildGraph(value);assert.equal(graph.sha256,await sha256(JSON.stringify(value)));
}));
test('migration retains exact raw backup, all legacy fields, versions, receipts and independent object identities',async()=>harness(async(db,restart)=>{
 const doc=fixture();doc.baselines=[{id:'BL-001',name:'Frozen',date:'2020-01-01',requirements:structuredClone(doc.requirements),sections:structuredClone(doc.sections)}];
 doc.proposals=[{id:'CP-001',title:'Pending',status:'Draft',baseRequirements:structuredClone(doc.requirements),requirements:structuredClone(doc.requirements),baseSections:structuredClone(doc.sections)}];
 const raw=JSON.stringify(doc,null,2);await db.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(doc.id,raw,doc.version).run();
 await db.prepare('INSERT INTO mcp_receipts VALUES(?,?,?,?,?)').bind('old',doc.id,'fingerprint',JSON.stringify({old:true}),Date.now()+86400000).run();
 const result=await migrateWorkspaceStorage(db,doc.id,doc.version);assert.equal(result.sha256,await sha256(JSON.stringify(doc)));
 let store=new McpStore(db);assert.deepEqual(await store.read(doc.id),doc);assert.deepEqual(await store.replay('old','fingerprint',Date.now()),{old:true});
 const backup=await db.prepare('SELECT * FROM workspace_storage_versions WHERE project=? AND version=?').bind(doc.id,doc.version).first();
 assert.equal(await readStoredRecord(db,doc.id,backup.legacy_data),raw);assert.deepEqual(await readStoredRecord(db,doc.id,backup.data),doc);
 const reread=await store.read(doc.id);reread.requirements[0].description='changed';assert.equal(reread.baselines[0].requirements[0].description,doc.requirements[0].description);assert.equal(reread.proposals[0].requirements[0].description,doc.requirements[0].description);
 assert.equal((await migrateWorkspaceStorage(db,doc.id,doc.version)).status,'already_migrated');
 db=await restart();store=new McpStore(db);assert.deepEqual(await store.read(doc.id),doc);
}));
test('failed staging and failed final commit never replace legacy data or create successful receipts',async()=>harness(async db=>{
 const doc=fixture(),raw=JSON.stringify(doc);await db.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(doc.id,raw,doc.version).run();
 await db.prepare("CREATE TRIGGER fail_record BEFORE INSERT ON workspace_records BEGIN SELECT RAISE(ABORT,'stage failure'); END").run();
 await assert.rejects(()=>migrateWorkspaceStorage(db,doc.id,doc.version));assert.equal((await db.prepare('SELECT data FROM workspaces').first()).data,raw);await db.prepare('DROP TRIGGER fail_record').run();
 await db.prepare("CREATE TRIGGER fail_root BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'commit failure'); END").run();
 await assert.rejects(()=>migrateWorkspaceStorage(db,doc.id,doc.version));assert.equal((await db.prepare('SELECT data FROM workspaces').first()).data,raw);assert.equal((await db.prepare('SELECT count(*) n FROM workspace_storage_versions').first()).n,0);
 const store=new McpStore(db);await assert.rejects(()=>callTool(store,'create_proposal',{project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:'failed-proposal',title:'Pending preservation'},{id:'owner'},'failure'));
 assert.equal((await db.prepare('SELECT count(*) n FROM mcp_receipts').first()).n,0);assert.equal((await db.prepare('SELECT data FROM workspaces').first()).data,raw);
}));
test('competing commits and stale migration preserve the winning workspace and retry result',async()=>harness(async(db,restart)=>{
 const doc=fixture();await db.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(doc.id,await encodeWorkspace(doc),doc.version).run();let store=new McpStore(db);
 const args={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:'parallel-create',title:'Concurrent proposal'};
 const [a,b]=await Promise.all([callTool(store,'create_proposal',args,{id:'owner'},'a'),callTool(store,'create_proposal',args,{id:'owner'},'b')]);assert.deepEqual(a,b);
 const saved=await store.read(doc.id);assert.equal(saved.proposals.length,1);assert.equal(saved.version,doc.version+1);
 await assert.rejects(()=>migrateWorkspaceStorage(db,doc.id,doc.version),/CONFLICT/);
 const original=await db.prepare('SELECT data FROM workspace_storage_versions WHERE project=? AND version=?').bind(doc.id,doc.version).first();assert.deepEqual(await readStoredRecord(db,doc.id,original.data),doc);
 db=await restart();store=new McpStore(db);assert.deepEqual(await callTool(store,'create_proposal',args,{id:'owner'},'retry'),a);assert.deepEqual(await store.read(doc.id),saved);
}));
test('missing or corrupted records fail closed instead of returning partial data',async()=>harness(async db=>{
 const value=fixture(),stored=await prepareStoredRecord(db,value.id,value),root=JSON.parse(stored.data).root;
 await db.prepare('UPDATE workspace_records SET data=? WHERE project=? AND hash=?').bind('{"type":"value","value":null}',value.id,root).run();
 await assert.rejects(()=>readStoredRecord(db,value.id,stored.data),/integrity/);
 await db.prepare('DELETE FROM workspace_records WHERE project=? AND hash=?').bind(value.id,root).run();await assert.rejects(()=>readStoredRecord(db,value.id,stored.data),/Missing/);
}));
test('large record trees load with bounded remote round trips and preserve shared snapshots',async()=>harness(async db=>{
 const requirements=Array.from({length:1500},(_,i)=>({id:'R-'+i,source:'Requirement '+i+' '+ 'retained content '.repeat(100)}));
 const value={id:'large-read',requirements,baselines:[{requirements:structuredClone(requirements)}]};
 const stored=await prepareStoredRecord(db,value.id,value);
 let roundTrips=0;
 const remote={
  prepare:sql=>({bind:(...args)=>{
   const bound=db.prepare(sql).bind(...args);
   return new Proxy(bound,{get(target,key){if(key==='all')return async()=>{roundTrips++;return target.all();};return Reflect.get(target,key);}});
  }}),
  batch:async statements=>{roundTrips++;return db.batch(statements);}
 };
 const loaded=await readStoredRecord(remote,value.id,stored.data);
 assert.deepEqual(loaded,value);
 assert.ok(roundTrips<=15,'Large-project reads must not perform dozens of sequential network round trips: '+roundTrips);
 loaded.requirements[0].source='Edited';assert.equal(loaded.baselines[0].requirements[0].source,requirements[0].source);
}));
if(process.env.WORKSPACE_BACKUP_PATH)test('production backup survives migration, restart, proposal write, and receipt replay with all frozen records intact',async()=>harness(async(db,restart)=>{
 const doc=JSON.parse(await readFile(process.env.WORKSPACE_BACKUP_PATH,'utf8'));const encoded=await encodeWorkspace(doc);
 // New production backups can exceed the legacy cell limit even compressed.
 // Seed those in the current format, just as they exist in production.
 const raw=Buffer.byteLength(encoded)>1_900_000?(await prepareStoredRecord(db,doc.id,doc)).data:encoded;
 await db.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(doc.id,raw,doc.version).run();
 const beforeHash=await sha256(JSON.stringify(doc));const result=await migrateWorkspaceStorage(db,doc.id,doc.version);assert.equal(result.sha256,beforeHash);
 let store=new McpStore(db);assert.deepEqual(await store.read(doc.id),doc);
 const args={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:'production-copy-check',title:'Local preservation check'};
 const written=await callTool(store,'create_proposal',args,{id:'local-test'},'production-copy');let saved=await store.read(doc.id);
 for(const field of ['requirements','baselines','requirementHistory','evidence','snapshotImplementations','requirementLifecycle'])assert.deepEqual(saved[field],doc[field]);assert.deepEqual(saved.proposals.slice(1),doc.proposals);
 db=await restart();store=new McpStore(db);assert.deepEqual(await store.read(doc.id),saved);assert.deepEqual(await callTool(store,'create_proposal',args,{id:'local-test'},'retry'),written);
 console.log(JSON.stringify({productionCopyVerified:true,version:doc.version,sha256:beforeHash,records:(await db.prepare('SELECT count(*) n FROM workspace_records').first()).n,maxRecordBytes:(await db.prepare('SELECT max(length(CAST(data AS BLOB))) n FROM workspace_records').first()).n}));
}));

function countedDatabase(db){
 const calls={total:0};
 const wrap=statement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return (...args)=>wrap(target.bind(...args));
  if(['first','all','run','raw'].includes(key))return async(...args)=>{calls.total++;return target[key](...args);};
  return Reflect.get(target,key);
 }});
 return {calls,db:{prepare:sql=>wrap(db.prepare(sql)),batch:async statements=>{calls.total++;return db.batch(statements);}}};
}
test('incremental saves reuse verified records, retain archives and roll back failed publication',async()=>harness(async db=>{
 const doc={...fixture(),history:Array.from({length:1500},(_,i)=>({id:String(i),message:'Retained history '+i+' '+ 'source '.repeat(100)}))};
 const stored=await prepareStoredRecord(db,doc.id,doc);
 await db.batch([db.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(doc.id,stored.data,doc.version),db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,created_at) VALUES(?,?,?,?,?)').bind(doc.id,doc.version,stored.data,stored.sha256,'original date')]);
 const tracked=countedDatabase(db),session=new StoredRecordSession(tracked.db,doc.id);
 const loaded=await readStoredRecord(tracked.db,doc.id,stored.data,session);
 const next={...loaded,version:doc.version+1,name:'Renamed safely'};
 tracked.calls.total=0;
 const prepared=await prepareWorkspaceCommit(tracked.db,doc.id,doc.version,next,session);
 assert.ok(tracked.calls.total<=5,'Writing a small change must not reread every historical record: '+tracked.calls.total);
 assert.ok(prepared.next.newRecords<10);
 const publish=()=>db.batch([prepared.backup,db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,created_at) VALUES(?,?,?,?,?)').bind(doc.id,next.version,prepared.next.data,prepared.next.sha256,'next date'),db.prepare('UPDATE workspaces SET data=?,version=? WHERE id=? AND version=?').bind(prepared.next.data,next.version,doc.id,doc.version)]);
 await db.prepare("CREATE TRIGGER fail_incremental BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'publication failure'); END").run();
 await assert.rejects(publish,/publication failure/);
 assert.equal((await db.prepare('SELECT version FROM workspaces').first()).version,doc.version);
 assert.equal((await db.prepare('SELECT count(*) n FROM workspace_storage_versions').first()).n,1);
 await db.prepare('DROP TRIGGER fail_incremental').run();await publish();
 assert.deepEqual(await readStoredRecord(db,doc.id,prepared.next.data),next);
 const archive=await db.prepare('SELECT data,created_at FROM workspace_storage_versions WHERE version=?').bind(doc.version).first();
 assert.equal(archive.created_at,'original date');assert.deepEqual(await readStoredRecord(db,doc.id,archive.data),doc);
 await assert.rejects(()=>prepareStoredRecord(db,'another-project',next,session),/another project/);
}));
test('incremental verification rejects an existing corrupt record and a silently missing staged record',async()=>harness(async db=>{
 const doc=fixture(),value={...doc,name:'Unique next content'};
 const graph=await buildGraph(value),bad=[...graph.records].find(([,data])=>data.includes('Unique next content'));
 await db.prepare('INSERT INTO workspace_records VALUES(?,?,?)').bind(doc.id,bad[0],'{"type":"value","value":"wrong"}').run();
 await assert.rejects(()=>prepareStoredRecord(db,doc.id,value),/integrity/);
 await db.prepare('DELETE FROM workspace_records').run();
 await db.prepare("CREATE TRIGGER ignore_staging BEFORE INSERT ON workspace_records BEGIN SELECT RAISE(IGNORE); END").run();
 await assert.rejects(()=>prepareStoredRecord(db,doc.id,value),/Missing/);
}));
if(process.env.WORKSPACE_BACKUP_PATH)test('Apply and snapshot on the complete production copy preserves history and survives restart',async()=>harness(async(db,restart)=>{
 const doc=JSON.parse(await readFile(process.env.WORKSPACE_BACKUP_PATH,'utf8'));
 const proposal=createProposal(doc,{title:'Local apply performance verification'});
 editProposalRequirement(doc,proposal.id,{...doc.requirements.find(r=>r.kind!=='information'),title:'Local performance verification requirement'});
 submitProposal(doc,proposal.id);
 const stored=await prepareStoredRecord(db,doc.id,doc);
 await db.batch([db.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(doc.id,stored.data,doc.version),db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,created_at) VALUES(?,?,?,?,?)').bind(doc.id,doc.version,stored.data,stored.sha256,'original')]);
 const counted=countedDatabase(db),session=new StoredRecordSession(counted.db,doc.id),started=performance.now();
 const loaded=await readStoredRecord(counted.db,doc.id,stored.data,session),original=structuredClone(loaded);
 reviewProposal(loaded,proposal.id,{decision:'apply'});captureRequirementHistory(original,loaded,{source:'proposal_review',actor:{id:'local-test'}});
 loaded.version++;
 const reads=counted.calls.total;counted.calls.total=0;
 const prepared=await prepareWorkspaceCommit(counted.db,doc.id,doc.version,loaded,session);
 await counted.db.batch([prepared.backup,db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,created_at) VALUES(?,?,?,?,?)').bind(doc.id,loaded.version,prepared.next.data,prepared.next.sha256,'next'),db.prepare('UPDATE workspaces SET data=?,version=? WHERE id=? AND version=?').bind(prepared.next.data,loaded.version,doc.id,doc.version)]);
 const elapsedMs=Math.round(performance.now()-started),writeRoundTrips=counted.calls.total;
 assert.ok(writeRoundTrips<=8,'Apply must persist only new records: '+writeRoundTrips);
 assert.equal(loaded.requirementsVersion,doc.requirementsVersion+1);
 assert.equal(loaded.proposals.find(p=>p.id===proposal.id).status,'Applied');
 assert.deepEqual(loaded.baselines.slice(1),doc.baselines);
 assert.deepEqual(loaded.baselines[0].requirements,loaded.requirements);
 assert.deepEqual(loaded.proposals.slice(1),doc.proposals.slice(1));
 for(const [id,history] of Object.entries(doc.requirementHistory??{}))for(const event of history.events)assert.ok(loaded.requirementHistory[id].events.some(e=>JSON.stringify(e)===JSON.stringify(event)));
 db=await restart();assert.deepEqual(await new McpStore(db).read(doc.id),loaded);
 console.log(JSON.stringify({productionApplyVerified:true,elapsedMs,readRoundTrips:reads,writeRoundTrips,newRecords:prepared.next.newRecords,previousSnapshots:doc.baselines.length}));
}));
