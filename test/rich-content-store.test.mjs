import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {McpStore} from '../db/mcp-store.ts';
import {authorRequirements} from '../lib/proposal-authoring.ts';

test('rich source, ten-summary references and mappings remain atomic across D1 rollback and restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'wonderworks-authoring-'));
 const start=()=>new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'authoring'},d1Persist:dir});
 let mf=start();
 try{
  let db=await mf.getD1Database('DB');
  for(const file of ['0000_graceful_terror.sql','0001_lowly_talos.sql'])for(const sql of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint'))await db.prepare(sql).run();
  const doc={id:'authoring',name:'Atomic authoring',prefix:'AT',version:0,requirementsVersion:1,sections:[{id:'section',title:'Core',description:''}],requirements:[],proposals:[],baselines:[],evidence:[],history:[],repositories:[]};
  await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,0)').bind(doc.id,JSON.stringify(doc)).run();let store=new McpStore(db);
  const req={section:'section',title:'Atomic new behavior',description:'The requirement appears once in its proposal.',criteria:['The accepted set stays unchanged.'],priority:'High',status:'Draft',parameters:{enabled:true},links:[],tags:['proposal']};
  const args={project_id:doc.id,expected_workspace_version:0,idempotency_key:'atomic-create-and-stage',new_proposal:{title:'Atomic authoring proposal'},operations:[{op:'add',client_ref:'a',requirement:req},{op:'add',client_ref:'b',requirement:{...req,kind:'information',body_format:'markdown',criteria:[],parameters:{},title:'Summary explanation',description:'  Exact 😀 source\n\n',summarizes:[{requirement_id:'$a'}],diagrams:[{id:'flow',language:'mermaid',source:'flowchart LR\n A-->B',title:'Overview',alt:'A leads to B',position:0}],diagram_mappings:[{block_id:'flow',part:'A',requirement_ids:['$a']}]}}]};
  await t.test('invalid fields and final graph persist nothing',async()=>{
   for(const change of [{new_proposal:{title:'x'}},{operations:[{op:'add',client_ref:'a',requirement:{...req,links:['AT-999']}}]},{operations:[{op:'add',client_ref:'a',requirement:{...req,links:['$b']}},{op:'add',client_ref:'b',requirement:{...req,links:['$a']}}]}])await assert.rejects(()=>authorRequirements(store,{...args,...change},{id:'owner'}),{code:'VALIDATION_ERROR'});
   assert.deepEqual(await store.read(doc.id),doc);
  });
  await t.test('storage failure after receipt insertion rolls back every part',async()=>{
   await db.prepare("CREATE TRIGGER fail BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'injected failure'); END").run();
   await assert.rejects(()=>authorRequirements(store,args,{id:'owner'}));assert.deepEqual(await store.read(doc.id),doc);assert.equal((await db.prepare('SELECT count(*) n FROM mcp_receipts').first()).n,0);await db.prepare('DROP TRIGGER fail').run();
  });
  const results=await Promise.all([authorRequirements(store,args,{id:'owner'}),authorRequirements(store,args,{id:'owner'})]);assert.deepEqual(results[0],results[1]);const saved=await store.read(doc.id);
  assert.equal(saved.version,1);assert.equal(saved.proposals.length,1);assert.equal(saved.history.length,1);assert.equal(saved.nextSequence,3);assert.deepEqual(saved.requirements,[]);assert.equal(saved.requirementsVersion,1);assert.equal(saved.proposals[0].requirements[1].summarizes[0].requirement_id,'AT-001');assert.equal(saved.proposals[0].requirements[1].summarizes[0].reviewed_revision,1);assert.equal(saved.proposals[0].requirements[1].diagrams[0].source,'flowchart LR\n A-->B');
  await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);
  await t.test('lost result survives restart, actor isolation, stale new writes, and altered retry arguments',async()=>{
   assert.deepEqual(await authorRequirements(store,args,{id:'owner'}),results[0]);assert.deepEqual(await store.read(doc.id),saved);
   await assert.rejects(()=>authorRequirements(store,{...args,new_proposal:{title:'Changed retry'}},{id:'owner'}),{code:'IDEMPOTENCY_KEY_REUSED'});
   await assert.rejects(()=>authorRequirements(store,args,{id:'another'}),{code:'CONFLICT'});
   await assert.rejects(()=>authorRequirements(store,{...args,idempotency_key:'different-new-write'},{id:'owner'}),{code:'CONFLICT'});
  });
  await t.test('final reference validation permits atomic summary and source deletion',async()=>{
   const update={project_id:doc.id,expected_workspace_version:1,idempotency_key:'delete-dependent-batch',proposal_id:'CP-001',operations:[{op:'delete',requirement_id:'AT-001'},{op:'delete',requirement_id:'AT-002'}]};
   await assert.rejects(()=>authorRequirements(store,{...update,operations:update.operations.slice(0,1)},{id:'owner'}),{code:'VALIDATION_ERROR'});assert.deepEqual(await store.read(doc.id),saved);
   await authorRequirements(store,update,{id:'owner'});assert.deepEqual((await store.read(doc.id)).proposals[0].requirements,[]);
  });
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
