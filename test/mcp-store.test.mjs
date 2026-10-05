import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {McpStore} from '../db/mcp-store.ts';
import {callTool} from '../lib/mcp/service.ts';

test('real D1 transactions roll back failed writes and receipts survive worker replacement',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wonderworks-mcp-d1-'));
  const start=()=>new Miniflare({modules:true,script:'export default { fetch() { return new Response("test"); } }',compatibilityDate:'2026-05-15',d1Databases:{DB:'test-mcp'},d1Persist:directory});
  let mf=start();
  try{
    let db=await mf.getD1Database('DB');
    for(const file of ['0000_graceful_terror.sql','0001_lowly_talos.sql','0002_clammy_wasp.sql','0003_workspace_portability.sql','0004_workspace_deletion.sql']){
      const sql=await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8');
      for(const statement of sql.split('--> statement-breakpoint'))await db.prepare(statement).run();
    }
    const doc={id:'project',name:'D1 fault QA',prefix:'DQ',version:0,requirementsVersion:1,sections:[{id:'section',title:'Tag behavior',description:''}],requirements:[{id:'DQ-001',section:'section',title:'Stored requirement',description:'Preserve atomic tag changes.',criteria:['Tags survive retries.'],priority:'High',status:'Draft',parameters:{},links:[],revision:1}],proposals:[],baselines:[],evidence:[],history:[]};
    await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(doc.id,JSON.stringify(doc),0).run();
    let store=new McpStore(db);
    const actor={id:'actor'},args={project_id:doc.id,expected_workspace_version:0,idempotency_key:'durable-retry-key',title:'Durable proposal',description:''};
    await t.test('failure after receipt insertion rolls back the whole transaction',async()=>{
      await db.prepare("CREATE TRIGGER fail_save BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'injected save failure'); END").run();
      await assert.rejects(()=>callTool(store,'create_proposal',args,actor,'failure'));
      assert.deepEqual(await store.read(doc.id),{...doc,repositories:[]});
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').first()).count,0);
      await db.prepare('DROP TRIGGER fail_save').run();
    });
    const result=await callTool(store,'create_proposal',args,actor,'first-success');
    assert.equal(result.workspace_version,1);
    await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);
    await t.test('restart retains original result and does not duplicate history or proposal',async()=>{
      assert.deepEqual(await callTool(store,'create_proposal',args,actor,'after-restart'),result);
      const saved=await store.read(doc.id);assert.equal(saved.version,1);assert.equal(saved.proposals.length,1);assert.equal(saved.history.length,1);assert.equal(saved.history[0].mcp.correlationId,'first-success');
      await assert.rejects(()=>callTool(store,'create_proposal',{...args,title:'Different arguments'},actor,'bad-reuse'),{code:'IDEMPOTENCY_KEY_REUSED'});
      await assert.rejects(()=>callTool(store,'create_proposal',args,{id:'another-actor'},'wrong-actor'),{code:'CONFLICT'});
    });
    await t.test('expired retry cannot silently repeat an old stale write',async()=>{
      await assert.rejects(()=>callTool(store,'create_proposal',args,actor,'expired',Date.now()+25*3600000),{code:'CONFLICT'});
      assert.equal((await store.read(doc.id)).version,1);
    });
    await t.test('simultaneous identical retries persist one result and one activity entry',async()=>{
      const next={...args,expected_workspace_version:1,idempotency_key:'concurrent-identical-key'};
      const results=await Promise.all([callTool(store,'create_proposal',next,actor,'concurrent-one'),callTool(store,'create_proposal',next,actor,'concurrent-two')]);
      assert.deepEqual(results[0],results[1]);const saved=await store.read(doc.id);assert.equal(saved.version,2);assert.equal(saved.proposals.length,2);assert.equal(saved.history.length,2);
    });
    const beforeTags=await store.read(doc.id);
    const tagArgs={project_id:doc.id,expected_workspace_version:2,idempotency_key:'durable-tag-retry',proposal_id:'CP-002',operations:[{op:'edit',requirement_id:'DQ-001',requirement:{section:'section',title:'Stored requirement',description:'Preserve atomic tag changes.',criteria:['Tags survive retries.'],priority:'High',status:'Draft',parameters:{},links:[],tags:['mcp','reliability']}}]};
    await t.test('failed durable tag staging preserves all content, IDs, receipts and successful activity',async()=>{
      const receipts=(await db.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').first()).count;
      await db.prepare("CREATE TRIGGER fail_tags BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'injected tag save failure'); END").run();
      await assert.rejects(()=>callTool(store,'stage_proposal_changes',tagArgs,actor,'failed-tags'));
      assert.deepEqual(await store.read(doc.id),beforeTags);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').first()).count,receipts);
      await db.prepare('DROP TRIGGER fail_tags').run();
    });
    const tagResult=await callTool(store,'stage_proposal_changes',tagArgs,actor,'saved-tags');
    await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);
    await t.test('tag staging receipt survives worker replacement without duplicate activity',async()=>{
      assert.deepEqual(await callTool(store,'stage_proposal_changes',tagArgs,actor,'retried-tags'),tagResult);
      const after=await store.read(doc.id);
      assert.equal(after.version,3);assert.equal(after.history.length,beforeTags.history.length+1);
      assert.deepEqual(after.requirements,beforeTags.requirements);
      assert.deepEqual(after.proposals.find(p=>p.id==='CP-002').requirements[0].tags,['mcp','reliability']);
      assert.deepEqual(after.baselines,beforeTags.baselines);
    });
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
