import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {McpStore} from '../db/mcp-store.ts';
import {callTool} from '../lib/mcp/service.ts';
import {firstInclusion,snapshotAssociations} from '../lib/snapshot-implementation.ts';
import {workspace,apply,frozen} from './fixtures/snapshot-workspace.mjs';
test('real D1 rollback, durable retries, no-ops, concurrent writes and failed application preserve associations',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wonderworks-implementation-'));
  const start=()=>new Miniflare({modules:true,script:'export default { fetch() { return new Response("test"); } }',compatibilityDate:'2026-05-15',d1Databases:{DB:'implementation-test'},d1Persist:dir});let mf=start();
  try{
    let db=await mf.getD1Database('DB');for(const file of ['0000_graceful_terror.sql','0001_lowly_talos.sql','0002_clammy_wasp.sql','0003_workspace_portability.sql','0004_workspace_deletion.sql'])for(const sql of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint'))await db.prepare(sql).run();
    const doc=workspace();await db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(doc.id,JSON.stringify(doc),doc.version).run();let store=new McpStore(db);const actor={id:'authenticated-actor',clientName:'Reported test client'};
    const args={project_id:doc.id,baseline_id:'BL-001',expected_workspace_version:0,idempotency_key:'durable-commit-retry',implementation_commit:{commit_id:'a'.repeat(40),repository_id:'repo'}};
    const before=await store.read(doc.id);
    await db.prepare("CREATE TRIGGER fail_metadata BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END").run();await assert.rejects(()=>callTool(store,'set_snapshot_implementation',args,actor,'failure'));assert.deepEqual(await store.read(doc.id),before);assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM mcp_receipts').first()).count,0);
    await db.prepare('DROP TRIGGER fail_metadata').run();const saved=await callTool(store,'set_snapshot_implementation',args,actor,'saved');assert.equal(saved.workspace_version,1);assert.equal(saved.implementation_actor.id,actor.id);
    await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);assert.deepEqual(await callTool(store,'set_snapshot_implementation',args,actor,'retry'),saved);
    const after=await store.read(doc.id);assert.equal(after.snapshotImplementations['BL-001'].history.length,1);assert.equal(after.history[0].snapshotImplementation.after.commit_id,'a'.repeat(40));assert.equal(frozen(after),frozen(before));
    await assert.rejects(()=>callTool(store,'set_snapshot_implementation',{...args,implementation_commit:null},actor,'changed'),{code:'IDEMPOTENCY_KEY_REUSED'});
    await assert.rejects(()=>callTool(store,'set_snapshot_implementation',{...args,idempotency_key:'different-stale-key'},actor,'stale'),{code:'CONFLICT'});
    const noopArgs={...args,expected_workspace_version:1,idempotency_key:'normalized-noop-key',implementation_commit:{...args.implementation_commit,commit_id:' AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA '}};
    const noop=await callTool(store,'set_snapshot_implementation',noopArgs,actor,'noop');assert.equal(noop.workspace_version,1);assert.equal(noop.implementation_updated_at,saved.implementation_updated_at);assert.deepEqual(await store.read(doc.id),after);
    await mf.dispose();mf=start();db=await mf.getD1Database('DB');store=new McpStore(db);assert.deepEqual(await callTool(store,'set_snapshot_implementation',noopArgs,actor,'noop retry'),noop);
    const applied=await store.read(doc.id);apply(applied);const receipt={key:'apply-snapshot-link',project:doc.id,fingerprint:'apply',result:{workspace_version:2},expiresAt:Date.now()+3600000};
    await db.prepare("CREATE TRIGGER fail_application BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'injected application failure'); END").run();await assert.rejects(()=>store.commit(applied,1,receipt,Date.now()));assert.deepEqual(await store.read(doc.id),after);assert.equal(firstInclusion(await store.read(doc.id),after.proposals[0]).state,'not_yet_included');
    await db.prepare('DROP TRIGGER fail_application').run();await store.commit(applied,1,receipt,Date.now());const accepted=await store.read(doc.id);assert.equal(firstInclusion(accepted,accepted.proposals[0]).snapshot.id,'BL-002');assert.equal(snapshotAssociations(accepted,'BL-002').first_included_proposals.length,1);
    const concurrent={...args,expected_workspace_version:2,idempotency_key:'concurrent-first-key',implementation_commit:null};const outcomes=await Promise.allSettled([callTool(store,'set_snapshot_implementation',concurrent,actor,'first'),callTool(store,'set_snapshot_implementation',{...concurrent,idempotency_key:'concurrent-second-key',implementation_commit:{commit_id:'b'.repeat(64)}},actor,'second')]);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(outcomes.find(o=>o.status==='rejected').reason.code,'CONFLICT');
    const final=await store.read(doc.id);assert.equal(final.version,3);assert.equal(final.snapshotImplementations['BL-001'].history.length,2);assert.equal(frozen(final),frozen(accepted));
  }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
