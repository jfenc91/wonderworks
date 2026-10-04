import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeWorkspace,decodeWorkspace} from '../db/workspace-codec.ts';
import {McpStore} from '../db/mcp-store.ts';
import {callTool} from '../lib/mcp/service.ts';
import {Miniflare} from 'miniflare';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const doc={id:'large',name:'Large history 👩🏽‍💻',prefix:'LG',version:0,requirementsVersion:1,requirements:[],sections:[{id:'s',title:'Large specification',description:''}],repositories:[],proposals:[],baselines:[],evidence:[],history:[]};
test('legacy JSON and compressed Unicode/exact source round-trip without authored changes',async()=>{
 assert.equal(await encodeWorkspace(doc),JSON.stringify(doc));assert.deepEqual(await decodeWorkspace(JSON.stringify(doc)),doc);
 const large={...doc,history:[{id:'history',date:'2026-10-04',message:'  <literal> **source** 👩🏽‍💻 é\n\t'.repeat(300000)}]};const encoded=await encodeWorkspace(large);assert.equal(JSON.parse(encoded).name,large.name);assert.ok(encoded.length<100000);assert.deepEqual(await decodeWorkspace(encoded),large);
 await assert.rejects(()=>decodeWorkspace(JSON.stringify({storage_encoding:'wonderworks.workspace.gzip.v1',payload:'invalid'})));
});
test('large D1 lifecycle writes preserve complete history, frozen data, rollback, version gates and restart replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wonderworks-large-'));const start=()=>new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'large'},d1Persist:dir});let mf=start();
 try{
  let db=await mf.getD1Database('DB');for(const file of ['0000_graceful_terror.sql','0001_lowly_talos.sql'])for(const sql of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint'))await db.prepare(sql).run();
  const body='### Exact rich source 👩🏽‍💻\n\n| Name | Value |\n|---|---|\n| snake_case | x < y |\n'.repeat(100);
  const large=structuredClone(doc);large.requirements=Array.from({length:100},(_,i)=>({id:'LG-'+String(i+1).padStart(3,'0'),revision:1,section:'s',title:'Large requirement '+i,description:body,criteria:['Preserve the complete source.'],priority:'High',status:'Approved',parameters:{},links:[],tags:[],body_format:'markdown'}));
  large.baselines=Array.from({length:12},(_,i)=>({id:'BL-'+String(i+1).padStart(3,'0'),name:'Frozen '+i,date:'2026-10-04T00:00:00.000Z',requirementsVersion:1,requirements:structuredClone(large.requirements),sections:large.sections}));
  assert.ok(new TextEncoder().encode(JSON.stringify(large)).length>9_000_000);
  await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,0)').bind(large.id,await encodeWorkspace(large)).run();let store=new McpStore(db);assert.deepEqual(await store.read(large.id),large);assert.equal((await store.list())[0].name,large.name);
  const args={project_id:large.id,baseline_id:'BL-012',expected_workspace_version:0,idempotency_key:'large-atomic-write',implementation_commit:{commit_id:'a'.repeat(40)}};
  const call=()=>callTool(store,'set_snapshot_implementation',args,{id:'owner'},'large-correlation');
  await db.prepare("CREATE TRIGGER fail BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'injected large-row failure'); END").run();await assert.rejects(call);assert.deepEqual(await store.read(large.id),large);assert.equal((await db.prepare('SELECT count(*) n FROM mcp_receipts').first()).n,0);await db.prepare('DROP TRIGGER fail').run();
  const result=await call();assert.equal(result.affected_requirements.length,100);let saved=await store.read(large.id);assert.equal(saved.version,1);assert.equal(saved.requirementsVersion,1);assert.deepEqual(saved.baselines,large.baselines);assert.ok(saved.requirements.every(r=>r.status==='Implemented'&&r.description===body&&r.revision===1));for(const r of saved.requirements)assert.equal(saved.requirementHistory[r.id].events.at(-1).after.description,body);
  const raw=await db.prepare('SELECT data FROM workspaces WHERE id=?').bind(large.id).first();assert.ok(raw.data.length<512000);
  await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);assert.deepEqual(await call(),result);assert.deepEqual(await store.read(large.id),saved);
  const edited={...saved,version:2},receipt={key:'large-full-authoring-receipt',project:large.id,fingerprint:'large-fingerprint',result:edited,expiresAt:Date.now()+86400000};await store.commit(edited,1,receipt,Date.now());assert.deepEqual(await store.replay(receipt.key,receipt.fingerprint,Date.now()),edited);assert.ok((await db.prepare('SELECT length(result) n FROM mcp_receipts WHERE key=?').bind(receipt.key).first()).n<512000);saved=await store.read(large.id);
  await assert.rejects(()=>callTool(store,'set_snapshot_implementation',{...args,idempotency_key:'stale-large-write',implementation_commit:{commit_id:'b'.repeat(40)}},{id:'owner'},'stale-correlation'),e=>e.code==='CONFLICT');assert.deepEqual(await store.read(large.id),saved);
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
