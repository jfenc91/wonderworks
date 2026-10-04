import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {McpStore} from '../db/mcp-store.ts';
import {saveGuidance} from '../lib/guidance-settings.ts';
import {callTool} from '../lib/mcp/service.ts';
import {workspace} from './fixtures/snapshot-workspace.mjs';
test('guidance and attributable Activity commit atomically, survive restart and preserve no-op revisions',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'wonderworks-guidance-'));const start=()=>new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'guidance'},d1Persist:dir});let mf=start();
 try{
  let db=await mf.getD1Database('DB');for(const file of ['0000_graceful_terror.sql','0001_lowly_talos.sql'])for(const sql of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint'))await db.prepare(sql).run();
  const original=workspace('guidance-store');await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(original.id,JSON.stringify(original),original.version).run();let store=new McpStore(db);const before=await store.read(original.id),actor={id:'guidance-owner'};
  const args={project_id:original.id,expected_workspace_version:original.version,idempotency_key:'guidance-save-retry',overrides:{writing_strength_percent:100,record_snapshot_commit:false,custom_instructions:'Project-owned text 😀'}};
  await t.test('default reads do not persist a migration',async()=>{const raw=await db.prepare('SELECT * FROM workspaces').first();await callTool(store,'get_project',{project_id:original.id},actor,'read');assert.deepEqual(await db.prepare('SELECT * FROM workspaces').first(),raw);});
  await t.test('injected failure rolls back settings, activity and receipt',async()=>{await db.prepare("CREATE TRIGGER fail BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'save failure'); END").run();await assert.rejects(()=>saveGuidance(store,args,actor));assert.deepEqual(await store.read(original.id),before);assert.equal((await db.prepare('SELECT count(*) n FROM mcp_receipts').first()).n,0);await db.prepare('DROP TRIGGER fail').run();});
  const saved=await saveGuidance(store,args,actor);assert.equal(saved.agentGuidance.revision,1);assert.equal(saved.version,before.version+1);assert.equal(saved.history[0].agentGuidance.actor.id,actor.id);const protectedFields=['requirements','requirementsVersion','sections','proposals','baselines','evidence','snapshotImplementations','requirementHistory'];for(const key of protectedFields)assert.deepEqual(saved[key],before[key],key);
  await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);
  await t.test('retry is durable and identical saves preserve revision, timestamps and Activity',async()=>{assert.deepEqual(await saveGuidance(store,args,actor),saved);const noop=await saveGuidance(store,{...args,expected_workspace_version:saved.version,idempotency_key:'guidance-no-op'},actor);assert.deepEqual(noop,saved);await assert.rejects(()=>saveGuidance(store,{...args,idempotency_key:'guidance-stale-save'},actor),{code:'CONFLICT'});assert.deepEqual(await store.read(original.id),saved);});
  await t.test('reset is versioned once; no-op reset and failed retry leave protected data intact',async()=>{const reset=await saveGuidance(store,{...args,expected_workspace_version:saved.version,idempotency_key:'guidance-reset-save',overrides:{}},actor);assert.equal(reset.agentGuidance.revision,2);assert.equal(reset.version,saved.version+1);const noop=await saveGuidance(store,{...args,expected_workspace_version:reset.version,idempotency_key:'guidance-reset-noop',overrides:{}},actor);assert.deepEqual(noop,reset);for(const key of protectedFields)assert.deepEqual(reset[key],before[key],key);});
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
