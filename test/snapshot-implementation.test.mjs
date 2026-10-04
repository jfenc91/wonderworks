import test from 'node:test';
import assert from 'node:assert/strict';
import {firstInclusion,snapshotAssociations,implementationMetadata,setSnapshotImplementation} from '../lib/snapshot-implementation.ts';
import {snapshot,submitProposal,reviewProposal,rebaseProposal} from '../lib/workflow.ts';
import {upsert,record,reconcileWorkspace} from '../lib/requirements.ts';
import {callTool} from '../lib/mcp/service.ts';
import {toolMap} from '../lib/mcp/contracts.ts';
import {workspace,apply,frozen,input} from './fixtures/snapshot-workspace.mjs';
const actor={id:'trusted-user'},commit={commit_id:'A'.repeat(40),repository_id:'repo',commit_url:' https://example.com/commit/a '};

test('first inclusion is the atomic application snapshot for additions, edits and deletions',()=>{
  const doc=workspace(),p=doc.proposals[0];assert.equal(firstInclusion(doc,p).state,'not_yet_included');
  submitProposal(doc,p.id);assert.equal(firstInclusion(doc,p).state,'not_yet_included');reviewProposal(doc,p.id,{decision:'request_changes'});rebaseProposal(doc,p.id,{});assert.equal(firstInclusion(doc,p).state,'not_yet_included');
  apply(doc);const first=p.appliedSnapshot,accepted=structuredClone(firstInclusion(doc,p));
  assert.equal(first,'BL-002');assert.equal(accepted.snapshot.requirements_version,2);assert.deepEqual(doc.baselines[0].requirements.map(r=>r.id),['SI-001','SI-003']);assert.equal(doc.baselines[0].requirements[0].title,'Accepted change');assert.equal(snapshotAssociations(doc,first).first_included_proposals[0].id,p.id);
  upsert(doc,{...input({title:'Later direct edit'}),id:'SI-001'});const later=snapshot(doc,'Later snapshot');setSnapshotImplementation(doc,later.id,commit,actor);
  assert.deepEqual(firstInclusion(doc,p),accepted);assert.deepEqual(snapshotAssociations(doc,later.id).first_included_proposals,[]);
  setSnapshotImplementation(doc,first,commit,actor);assert.equal(firstInclusion(doc,p).snapshot.id,first);assert.equal(firstInclusion(doc,p).implementation_commit.commit_id,'a'.repeat(40));
});
test('legacy provenance is explicit, project scoped, and never inferred from identical content',()=>{
  const doc=workspace();apply(doc);const p=doc.proposals[0],saved=structuredClone(p);delete p.appliedSnapshot;
  assert.equal(firstInclusion(doc,p).state,'unknown');assert.equal(firstInclusion(doc,p).snapshot,null);
  p.appliedSnapshot='BL-999';assert.equal(firstInclusion(doc,p).original_snapshot_id,'BL-999');assert.equal(firstInclusion(doc,p).state,'unknown');assert.throws(()=>snapshotAssociations(doc,'BL-999'),{code:'NOT_FOUND'});
  Object.assign(p,saved);assert.equal(firstInclusion(doc,p).state,'known');delete doc.baselines[0].requirementsVersion;assert.equal(firstInclusion(doc,p).snapshot.requirements_version,p.appliedVersion);
  p.status='Rejected';assert.equal(firstInclusion(doc,p).state,'not_yet_included');assert.deepEqual(snapshotAssociations(doc,p.appliedSnapshot).first_included_proposals,[]);
  const other=workspace('other-project');assert.equal(firstInclusion(other,saved).state,'unknown');assert.throws(()=>setSnapshotImplementation(other,'BL-002',commit,actor),{code:'NOT_FOUND'});
  const original=structuredClone(other);implementationMetadata(other,'BL-001');snapshotAssociations(other,'BL-001');assert.deepEqual(other,original);assert.ok(!Object.hasOwn(other,'snapshotImplementations'));
});
test('normalization, whole reference replacement, explicit clear and immutable content',()=>{
  const doc=workspace();apply(doc);const original=frozen(doc);
  assert.equal(setSnapshotImplementation(doc,'BL-001',commit,actor,'2026-10-04T00:00:00.000Z'),true);
  const first=structuredClone(doc.snapshotImplementations);
  assert.equal(setSnapshotImplementation(doc,'BL-001',{...commit,commit_id:' '+commit.commit_id.toLowerCase()+' ',commit_url:commit.commit_url.trim()},actor),false);assert.deepEqual(doc.snapshotImplementations,first);
  assert.equal(setSnapshotImplementation(doc,'BL-001',{commit_id:'b'.repeat(64)},actor),true);assert.deepEqual(implementationMetadata(doc,'BL-001').implementation_commit,{commit_id:'b'.repeat(64)});
  setSnapshotImplementation(doc,'BL-002',{commit_id:'b'.repeat(64)},actor);assert.equal(setSnapshotImplementation(doc,'BL-001',null,actor),true);assert.equal(setSnapshotImplementation(doc,'BL-001',null,actor),false);assert.equal(doc.snapshotImplementations['BL-001'].history.length,3);assert.equal(frozen(doc),original);
  const correction=doc.snapshotImplementations['BL-001'].history.at(-1);assert.equal(correction.before.commit_id,'b'.repeat(64));assert.equal(correction.after,null);assert.deepEqual(correction.actor,actor);
});
test('invalid inputs and missing targets reject without mutation',()=>{
  const doc=workspace(),original=structuredClone(doc);
  for(const bad of [undefined,{},'',{commit_id:''},{commit_id:'main'},{commit_id:'a'.repeat(39)},{commit_id:'z'.repeat(40)},{commit_id:'a'.repeat(41)},{commit_id:'a'.repeat(65)},{commit_id:commit.commit_id,repository_id:'foreign-repo'},{commit_id:commit.commit_id,commit_url:'not a url'},{commit_id:commit.commit_id,commit_url:'/relative'},{commit_id:commit.commit_id,commit_url:'https:example.com'},{commit_id:commit.commit_id,commit_url:'http://example.com'},{commit_id:commit.commit_id,commit_url:'https://user:password@example.com'},{commit_id:commit.commit_id,commit_url:'javascript:alert(1)'},{commit_id:commit.commit_id,commit_url:'https://example.com/'+ 'a'.repeat(2048)},{commit_id:commit.commit_id,unknown:true}]){assert.throws(()=>setSnapshotImplementation(doc,'BL-001',bad,actor),{code:'VALIDATION_ERROR'});assert.deepEqual(doc,original);}
  assert.throws(()=>setSnapshotImplementation(doc,'BL-999',commit,actor),{code:'NOT_FOUND'});assert.deepEqual(doc,original);
});
test('captured repositories and durable corrections survive removal, imports and the Activity cap',()=>{
  const doc=workspace();setSnapshotImplementation(doc,'BL-001',commit,actor);const captured=structuredClone(doc.snapshotImplementations['BL-001'].implementation_commit.repository);
  doc.repositories[0].name='Renamed';doc.repositories[0].url='https://example.com/renamed';setSnapshotImplementation(doc,'BL-001',{...commit,commit_id:'b'.repeat(40)},actor);assert.deepEqual(doc.snapshotImplementations['BL-001'].implementation_commit.repository,captured);
  doc.repositories=[];setSnapshotImplementation(doc,'BL-001',{...commit,commit_id:'c'.repeat(40)},actor);assert.deepEqual(doc.snapshotImplementations['BL-001'].implementation_commit.repository,captured);
  for(let i=0;i<505;i++){setSnapshotImplementation(doc,'BL-001',{commit_id:i.toString(16).padStart(40,'0')},actor);record(doc,'Unrelated activity');}
  assert.equal(doc.history.length,500);assert.equal(doc.snapshotImplementations['BL-001'].history.length,508);
  const metadata=structuredClone(doc.snapshotImplementations),imported=structuredClone(doc);delete imported.snapshotImplementations;reconcileWorkspace(doc,imported);assert.deepEqual(doc.snapshotImplementations,metadata);
  imported.snapshotImplementations={forged:{actor:{id:'fake'}}};reconcileWorkspace(doc,imported);assert.deepEqual(doc.snapshotImplementations,metadata);
});
test('MCP schemas and reads expose derived associations and bounded, query-bound history without writes',async()=>{
  const doc=workspace();apply(doc);for(let i=0;i<3;i++)setSnapshotImplementation(doc,'BL-002',{commit_id:String(i).repeat(40)},actor);
  const store={read:async id=>{assert.equal(id,doc.id);return structuredClone(doc);},commit:()=>assert.fail('read tried to write')};
  const read=async(name,args={})=>{const result=await callTool(store,name,{project_id:doc.id,...args},actor,'read');toolMap.get(name).output.parse(result);return result;};
  const original=structuredClone(doc);assert.equal((await read('get_proposal',{proposal_id:'CP-001'})).proposal.first_included.snapshot.id,'BL-002');assert.equal((await read('list_proposals')).items[0].first_included.implementation_commit.commit_id,'2'.repeat(40));
  const result=await read('get_snapshot',{baseline_id:'BL-002'});assert.deepEqual(result.snapshot,doc.baselines[0]);assert.equal(result.associations.first_included_proposals[0].id,'CP-001');assert.equal((await read('list_snapshots')).items[1].implementation_commit,null);
  const page=await read('get_snapshot_implementation_history',{baseline_id:'BL-002',limit:1});assert.equal(page.items[0].after.commit_id,'2'.repeat(40));assert.equal((await read('get_snapshot_implementation_history',{baseline_id:'BL-002',limit:1,cursor:page.next_cursor})).items[0].after.commit_id,'1'.repeat(40));
  for(const args of [{baseline_id:'BL-001',limit:1,cursor:page.next_cursor},{baseline_id:'BL-002',limit:2,cursor:page.next_cursor},{baseline_id:'BL-002',cursor:'bad'}])await assert.rejects(()=>read('get_snapshot_implementation_history',args),{code:'INVALID_CURSOR'});
  await assert.rejects(()=>read('get_snapshot_implementation_history',{baseline_id:'BL-002',limit:101}),{code:'VALIDATION_ERROR'});assert.deepEqual(doc,original);
  doc.version++;await assert.rejects(()=>read('get_snapshot_implementation_history',{baseline_id:'BL-002',limit:1,cursor:page.next_cursor}),{code:'RESTART_REQUIRED'});
});
