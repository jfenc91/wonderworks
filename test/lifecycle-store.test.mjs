import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {McpStore} from '../db/mcp-store.ts';
import {callTool} from '../lib/mcp/service.ts';
import {reconcileProjectLifecycle} from '../lib/lifecycle-reconciliation.ts';
import {createProposal,editProposalRequirement,submitProposal,reviewProposal} from '../lib/workflow.ts';
import {captureRequirementHistory} from '../lib/requirement-history.ts';

test('multi-requirement lifecycle, corrections, history, Activity and receipts are atomic in real D1',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'wonderworks-lifecycle-'));
 const start=()=>new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'lifecycle'},d1Persist:dir});let mf=start();
 try{
  let db=await mf.getD1Database('DB');for(const file of ['0000_graceful_terror.sql','0001_lowly_talos.sql'])for(const sql of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint'))await db.prepare(sql).run();
  const doc={id:'lifecycle',name:'Atomic lifecycle',prefix:'LC',version:0,requirementsVersion:1,sections:[{id:'s',title:'Core',description:''}],requirements:[],proposals:[],baselines:[],evidence:[],history:[],repositories:[]};
  const p=createProposal(doc,{title:'Accepted batch'});for(let i=0;i<3;i++)editProposalRequirement(doc,p.id,{section:'s',title:'Behavior '+i,description:'Preserve exact accepted behavior.',criteria:['An observed outcome.']});
  let before=structuredClone(doc);submitProposal(doc,p.id);reviewProposal(doc,p.id,{decision:'apply'});captureRequirementHistory(before,doc,{source:'proposal_review',actor:{id:'owner'}});
  await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,0)').bind(doc.id,JSON.stringify(doc)).run();let store=new McpStore(db);
  const args={project_id:doc.id,baseline_id:p.appliedSnapshot,expected_workspace_version:0,idempotency_key:'atomic-multi-implementation',implementation_commit:{commit_id:'A'.repeat(40)}};
  const call=(value=args)=>callTool(store,'set_snapshot_implementation',value,{id:'owner'},'lifecycle-correlation');
  await t.test('failure after receipt insert persists neither statuses, provenance, events nor reference',async()=>{
   await db.prepare("CREATE TRIGGER fail BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'injected lifecycle failure'); END").run();await assert.rejects(()=>call());assert.deepEqual(await store.read(doc.id),doc);assert.equal((await db.prepare('SELECT count(*) n FROM mcp_receipts').first()).n,0);await db.prepare('DROP TRIGGER fail').run();
  });
  const results=await Promise.all([call(),call()]);assert.deepEqual(results[0],results[1]);let saved=await store.read(doc.id);assert.equal(saved.version,1);assert.equal(saved.requirementsVersion,doc.requirementsVersion);assert.ok(saved.requirements.every(r=>r.status==='Implemented'&&r.revision===1));assert.equal(results[0].affected_requirements.length,3);assert.equal(saved.history.length,doc.history.length+1);
  for(const r of saved.requirements){const events=saved.requirementHistory[r.id].events;assert.equal(events.length,doc.requirementHistory[r.id].events.length+1);assert.equal(events.at(-1).kind,'lifecycle');assert.equal(events.at(-1).lifecycle.commitId,'a'.repeat(40));}
  assert.deepEqual(saved.baselines,doc.baselines);assert.deepEqual(saved.proposals,doc.proposals);
  await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);
  await t.test('restart replay is original, normalized new requests are no-ops, and stale races reject atomically',async()=>{
   assert.deepEqual(await call(),results[0]);assert.deepEqual(await store.read(doc.id),saved);
   const noOp=await call({...args,expected_workspace_version:1,idempotency_key:'normalized-noop-write',implementation_commit:{commit_id:'a'.repeat(40)}});assert.equal(noOp.workspace_version,1);assert.deepEqual(await store.read(doc.id),saved);
   const race=await Promise.allSettled(['b','c'].map(v=>call({...args,expected_workspace_version:1,idempotency_key:'replacement-race-'+v,implementation_commit:{commit_id:v.repeat(40)}})));assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.find(r=>r.status==='rejected').reason.code,'CONFLICT');
   saved=await store.read(doc.id);assert.equal(saved.version,2);assert.ok(saved.requirements.every(r=>r.status==='Implemented'));for(const r of saved.requirements)assert.equal(saved.requirementHistory[r.id].events.filter(e=>e.lifecycle?.implementation).length,1);
  });
  await t.test('explicit clearing rolls back as one write, then returns every managed revision to Approved',async()=>{
   const clear={...args,expected_workspace_version:2,idempotency_key:'clear-last-support',implementation_commit:null};await db.prepare("CREATE TRIGGER fail BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'failure'); END").run();await assert.rejects(()=>call(clear));assert.deepEqual(await store.read(doc.id),saved);await db.prepare('DROP TRIGGER fail').run();const result=await call(clear);assert.ok(result.affected_requirements.every(r=>r.status==='Approved'));saved=await store.read(doc.id);assert.equal(saved.version,3);assert.deepEqual(saved.baselines,doc.baselines);
  });
  // Legacy record: keep saved acceptance, remove only the automated metadata
  // from this isolated fixture, and simulate old Draft statuses.
  const legacy=structuredClone(doc);legacy.id='legacy';delete legacy.requirementLifecycle;delete legacy.requirementHistory;legacy.requirements.forEach(r=>r.status='Draft');await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,0)').bind(legacy.id,JSON.stringify(legacy)).run();
  const reconcile={project_id:legacy.id,expected_workspace_version:0,idempotency_key:'reconcile-existing-records'};
  await t.test('reconciliation failure, recovery, restart and repeat runs preserve one recovered event',async()=>{
   await db.prepare("CREATE TRIGGER fail BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'failure'); END").run();await assert.rejects(()=>reconcileProjectLifecycle(store,reconcile,{id:'owner'}));assert.deepEqual(await store.read(legacy.id),legacy);await db.prepare('DROP TRIGGER fail').run();const result=await reconcileProjectLifecycle(store,reconcile,{id:'owner'});const recovered=await store.read(legacy.id);assert.ok(recovered.requirements.every(r=>r.status==='Approved'));assert.equal(recovered.version,1);assert.deepEqual(recovered.baselines,legacy.baselines);
   await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);assert.deepEqual(await reconcileProjectLifecycle(store,reconcile,{id:'owner'}),result);
   const again=await reconcileProjectLifecycle(store,{...reconcile,expected_workspace_version:1,idempotency_key:'repeat-reconciliation'},{id:'owner'});assert.equal(again.workspace_version,1);assert.deepEqual(await store.read(legacy.id),recovered);for(const r of recovered.requirements)assert.equal(recovered.requirementHistory[r.id].events.length,1);
  });
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
