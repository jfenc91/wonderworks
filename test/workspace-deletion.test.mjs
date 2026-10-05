import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Miniflare} from 'miniflare';
import {openDatabase,migrate} from '../server/database.mjs';
import {deleteWorkspace} from '../db/workspace-deletion.ts';
import {prepareStoredRecord,prepareWorkspaceCommit} from '../db/workspace-records.ts';
import {readWorkspace,listWorkspaces,saveWorkspace} from '../db/workspace.ts';
import {runWithDatabase} from '../db/runtime.ts';
import {McpStore} from '../db/mcp-store.ts';
import {callTool} from '../lib/mcp/service.ts';
import {captureArchive,completeArchive,decodeArchive,archiveDeletions} from '../lib/workspace-archive.ts';
import {previewArchive,importArchive} from '../db/archive-store.ts';
import {POST as removeRequest} from '../app/api/workspace-deletion/route.ts';
import {GET as readRequest,POST as saveRequest} from '../app/api/workspace/route.ts';
import {workspace,apply,input} from './fixtures/snapshot-workspace.mjs';
import {createProposal,editProposalRequirement,submitProposal,reviewProposal} from '../lib/workflow.ts';
import {setSnapshotImplementation} from '../lib/snapshot-implementation.ts';
const dir=await mkdtemp(join(tmpdir(),'ww-delete-'));
test.after(()=>rm(dir,{recursive:true,force:true}));
const actor='deletion-test-actor-'+crypto.randomUUID();
const args=doc=>({project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID()});
async function install(db){for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort())for(const sql of (await readFile('drizzle/'+file,'utf8')).split('--> statement-breakpoint'))await db.prepare(sql).run();}
async function put(db,doc){const stored=await prepareStoredRecord(db,doc.id,doc);await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(doc.id,stored.data,doc.version).run();return doc;}
async function archive(db,scope='all'){return decodeArchive((await completeArchive(await captureArchive(db,scope))).stream());}
for(const backend of ['sqlite','d1','postgres'])test(`${backend}: deletion, exact retry, conflict, isolation, rollback, old writes, archives and seed suppression`,{skip:backend==='postgres'&&!process.env.WW_TEST_POSTGRES_URL},async t=>{
  let db,mf,admin;const pgSchema='bl016_'+crypto.randomUUID().replaceAll('-','');let pgUrl=process.env.WW_TEST_POSTGRES_URL;if(backend==='postgres'){admin=await openDatabase({profile:'self-hosted',databaseUrl:pgUrl,tls:'disable'});await admin.exec('CREATE SCHEMA '+pgSchema);const url=new URL(pgUrl);url.searchParams.set('options','-csearch_path='+pgSchema);pgUrl=url.toString();}const path=join(dir,backend+'.sqlite');
  const start=async()=>{if(backend==='d1'){mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'deletion'},d1Persist:join(dir,'d1')});return mf.getD1Database('DB');}return openDatabase(backend==='sqlite'?{profile:'local',sqlitePath:path}:{profile:'self-hosted',databaseUrl:pgUrl,tls:'disable'},{create:true});};
  const stop=async()=>{if(mf)await mf.dispose();else await db.close();};
  try{
    db=await start();if(backend==='d1')await install(db);else await migrate(db);
    const doc=workspace('delete-'+crypto.randomUUID());
    editProposalRequirement(doc,doc.proposals[0].id,input({kind:'information',title:'Saved context',description:'Information removed with this workspace',criteria:[]}));
    apply(doc);doc.agentGuidance={revision:0,overrides:{custom_instructions:'Private project guidance'}};
    setSnapshotImplementation(doc,doc.baselines.at(-1).id,{commit_id:'a'.repeat(40),repository_id:'repo'},{id:actor});
    doc.evidence.push({...structuredClone(doc.evidence[0]),id:'passing-evidence',checks:[{id:'SI-001',title:'Passing result',passed:true,detail:'Saved passing evidence'}]});
    for(const state of ['Proposed','Rejected']){const proposal=createProposal(doc,{title:state+' saved proposal'});editProposalRequirement(doc,proposal.id,input({title:state+' new requirement'}));submitProposal(doc,proposal.id);if(state==='Rejected')reviewProposal(doc,proposal.id,{decision:'reject',note:'Preserve rejection until whole-workspace deletion'});}
    await put(db,doc);const other=await put(db,workspace('untouched-'+crypto.randomUUID()));
    const request={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:'prior-receipt-key',title:'Retained prior proposal',description:''};
    await callTool(new McpStore(db),'create_proposal',request,{id:actor},'before-delete');
    const current=await new McpStore(db).read(doc.id),confirmed=args(current),exported=await archive(db,doc.id);
    await assert.rejects(()=>deleteWorkspace(db,{...confirmed,expected_workspace_version:current.version-1},actor),e=>e.status===409);
    assert.deepEqual(await new McpStore(db).read(doc.id),current);
    // Fault injection after reservation must roll back every table.
    if(backend==='postgres')await db.exec("CREATE OR REPLACE FUNCTION ww_delete_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER ww_delete_failure BEFORE DELETE ON workspaces FOR EACH ROW EXECUTE FUNCTION ww_delete_fail();");
    else await db.exec("CREATE TRIGGER ww_delete_failure BEFORE DELETE ON workspaces BEGIN SELECT RAISE(ABORT,'injected'); END;");
    await assert.rejects(()=>deleteWorkspace(db,confirmed,actor));
    assert.deepEqual(await new McpStore(db).read(doc.id),current);assert.equal(await db.prepare('SELECT project FROM workspace_deletions WHERE project=?').bind(doc.id).first(),null);
    if(backend==='postgres')await db.exec('DROP TRIGGER ww_delete_failure ON workspaces; DROP FUNCTION ww_delete_fail();');else await db.exec('DROP TRIGGER ww_delete_failure');
    // Start staging a stale save before deletion; its later stages cannot leave payloads behind.
    await prepareWorkspaceCommit(db,current.id,current.version,{...current,version:current.version+1});
    const [one,two]=await Promise.all([deleteWorkspace(db,confirmed,actor),deleteWorkspace(db,confirmed,actor)]);assert.deepEqual(one,two);assert.equal(one.workspace_version,current.version+1);
    for(const table of ['workspace_records','workspace_storage_versions','mcp_receipts','workspace_provenance'])assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project=?`).bind(doc.id).first()).n),0,table);
    await assert.rejects(()=>prepareStoredRecord(db,doc.id,{secret:'late payload'}));
    await assert.rejects(()=>runWithDatabase(db,()=>saveWorkspace(current,current.version)));
    await assert.rejects(()=>callTool(new McpStore(db),'create_proposal',request,{id:actor},'old-retry'),{code:'NOT_FOUND'});
    assert.deepEqual(await new McpStore(db).read(other.id),other);
    await assert.rejects(()=>deleteWorkspace(db,{...confirmed,expected_workspace_version:99},actor),e=>e.status===409);
    await assert.rejects(()=>deleteWorkspace(db,confirmed,'another-actor'),e=>e.status===404);
    const preview=await previewArchive(db,exported);assert.equal(preview.projects[0].deleted,true);assert.equal(preview.projects[0].conflict,true);
    await assert.rejects(()=>importArchive(db,exported,[{id:doc.id,mode:'restore'}],actor,'deleted-original-id'));
    const copy=await importArchive(db,exported,[{id:doc.id,mode:'copy'}],actor,'deleted-copy-operation');
    assert.deepEqual({...await new McpStore(db).read(copy.projects[0].id),id:doc.id},current);
    await deleteWorkspace(db,args(await new McpStore(db).read(copy.projects[0].id)),actor);
    await assert.rejects(()=>importArchive(db,exported,[{id:doc.id,mode:'copy'}],actor,'deleted-copy-operation'),/deleted/);
    // Backup/restore preserves reservations and receipts on an empty backend.
    const backup=await archive(db);assert.equal(backup.manifest.version,2);assert.ok(archiveDeletions(backup).some(d=>d.project===doc.id));
    for(const destination of ['sqlite','d1',...(process.env.WW_TEST_POSTGRES_URL?['postgres']:[])]){
      let target,targetMf,targetAdmin;const targetSchema='restore_'+crypto.randomUUID().replaceAll('-','');
      try{
        if(destination==='d1'){targetMf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'restore'}});target=await targetMf.getD1Database('DB');await install(target);}
        else if(destination==='postgres'){targetAdmin=await openDatabase({profile:'self-hosted',databaseUrl:process.env.WW_TEST_POSTGRES_URL,tls:'disable'});await targetAdmin.exec('CREATE SCHEMA '+targetSchema);const targetUrl=new URL(process.env.WW_TEST_POSTGRES_URL);targetUrl.searchParams.set('options','-csearch_path='+targetSchema);target=await openDatabase({profile:'self-hosted',databaseUrl:targetUrl.toString(),tls:'disable'});await migrate(target);}
        else{target=await openDatabase({profile:'local',sqlitePath:join(dir,backend+'-restore.sqlite')},{create:true});await migrate(target);}
        await importArchive(target,backup,backup.manifest.projects.map(p=>({id:p.id,mode:'restore'})),actor,'restore-deletion-backup',{aborted:false},{emptyOnly:true});
        assert.deepEqual(await deleteWorkspace(target,confirmed,actor),one,backend+' to '+destination);
        await assert.rejects(()=>prepareStoredRecord(target,doc.id,{secret:'cannot restore'}));
      }finally{if(targetMf)await targetMf.dispose();else await target?.close();if(targetAdmin){await targetAdmin.exec('DROP SCHEMA '+targetSchema+' CASCADE');await targetAdmin.close();}}
    }
    // Seed projects are deletable and must remain absent after restart/index reads.
    await runWithDatabase(db,()=>listWorkspaces());const seed=await runWithDatabase(db,()=>readWorkspace('asteroids'));await deleteWorkspace(db,args(seed),actor);
    await stop();db=await start();assert.deepEqual(await deleteWorkspace(db,confirmed,actor),one);
    assert.ok(!(await runWithDatabase(db,()=>listWorkspaces())).some(p=>p.id==='asteroids'));
    const index=await new McpStore(db).list();for(const item of index)await deleteWorkspace(db,args(await new McpStore(db).read(item.id)),actor);
    assert.deepEqual(await runWithDatabase(db,()=>listWorkspaces()),[]);
    const empty=await archive(db);assert.equal(empty.manifest.projects.length,0);assert.ok(archiveDeletions(empty).length);
    const emptyTarget=await openDatabase({profile:'local',sqlitePath:join(dir,backend+'-empty.sqlite')},{create:true});await migrate(emptyTarget);
    try{await importArchive(emptyTarget,empty,[],actor,'restore-empty-deletions',undefined,{emptyOnly:true});assert.deepEqual(await runWithDatabase(emptyTarget,()=>listWorkspaces()),[]);}finally{await emptyTarget.close();}
  }finally{await stop();if(admin){await admin.exec('DROP SCHEMA '+pgSchema+' CASCADE');await admin.close();}}
});

test('REST authorization, input, origin, unavailable reads and exact replay',async()=>{
  const db=await openDatabase({profile:'local',sqlitePath:join(dir,'http.sqlite')},{create:true});await migrate(db);
  try{const doc=await put(db,workspace('http-delete')),input=args(doc);
    const post=(value=input,headers={})=>runWithDatabase(db,()=>removeRequest(new Request('http://localhost/api/workspace-deletion',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)})));
    assert.equal((await post()).status,401);assert.equal((await post(input,{'oai-sites-authorization':'service','oai-authenticated-user-id':actor})).status,401);
    const auth={'oai-authenticated-user-id':actor};assert.equal((await post(input,{...auth,Origin:'https://evil.test'})).status,403);
    for(const invalid of [{...input,project_id:''},{...input,expected_workspace_version:-1},{...input,idempotency_key:''},{...input,extra:true}])assert.equal((await post(invalid,auth)).status,400);
    const first=await post(input,auth);assert.equal(first.status,200);assert.deepEqual(await first.json(),await (await post(input,auth)).json());
    for(const query of ['?project='+doc.id,'?project='+doc.id+'&since=0'])assert.equal((await runWithDatabase(db,()=>readRequest(new Request('http://localhost/api/workspace'+query)))).status,404);
    assert.equal((await runWithDatabase(db,()=>saveRequest(new Request('http://localhost/api/workspace',{method:'POST',body:JSON.stringify({action:'section',project:doc.id,version:0,section:{title:'No recreation',description:''}})})))).status,404);
  }finally{await db.close();}
});
