import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptRequirements} from './fixtures/accepted-requirements.mjs';
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Use loopback QA storage.');
async function request(body,status=200,path='/api/workspace'){const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;}
test('every REST requirement entry point preserves the proposal boundary and rejects invalid complete sets',async t=>{
 let doc=await request({action:'project',name:'BL007 authoring API QA',prefix:'PA'});
 const read=async()=>doc=await (await fetch(origin+'/api/workspace?project='+doc.id)).json();
 const mutate=async(action,data={},status=200)=>{const d=await request({project:doc.id,version:doc.version,action,...data},status);if(status===200)doc=d;return d;};
 await mutate('section',{section:{title:'Behavior',description:''}});
 const input=(title,extra={})=>({section:doc.sections[0].id,title,description:'Proposal authoring preserves accepted requirements.',criteria:['The final graph is valid.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
 doc=await acceptRequirements(doc,[input('Foundation'),input('Dependent',{links:['PA-001']})],request);
 await mutate('evidence',{evidence:{baseline:doc.baselines[0].id,artifactUrl:'https://example.com/qa',summary:'Fixture evidence preserves baseline scope.',checks:[{id:'PA-001',title:'Fixture result',passed:true,detail:'Test fixture only.'}]}});
 const accepted=structuredClone({requirements:doc.requirements,version:doc.requirementsVersion,baselines:doc.baselines,evidence:doc.evidence});
 await t.test('missing, closed, nonexistent and cross-project targets never fall back to accepted',async()=>{
  const before=structuredClone(doc);
  for(const proposal_id of [undefined,'CP-999','CP-001']){await mutate('requirements',{proposal_id,requirements:[input('Forbidden direct write')]},400);await mutate('delete',{proposal_id,id:'PA-001'},400);}
  assert.deepEqual(await read(),before);
 });
 await mutate('proposal',{proposal:{title:'Staging destination'}});const id=doc.proposals[0].id;
 await t.test('all legacy stage routes validate final dependencies and roll back IDs and activity',async()=>{
  const before=structuredClone(doc);
  await mutate('proposal_delete',{id,requirementId:'PA-001'},400);
  await mutate('proposal_requirement',{id,requirement:{...doc.requirements[0],links:['PA-002']}},400);
  await mutate('requirements',{proposal_id:id,requirements:[input('Would reserve ID'),input('Invalid last member',{links:['PA-999']})]},400);
  await mutate('requirements',{proposal_id:id,requirements:Array(101).fill(input('Too many'))},400);
  assert.deepEqual(await read(),before);
  await mutate('requirements',{proposal_id:id,requirements:[{...doc.requirements[1],links:[]},{...doc.requirements[0],title:'Every editable field',description:'A staged replacement description.',criteria:['First result','Second result'],priority:'Critical',status:'Approved',parameters:{limit:5},links:['PA-002'],tags:[' Staged ']}]});
  assert.deepEqual(doc.proposals[0].requirements[0].tags,['staged']);assert.equal(doc.proposals[0].requirements[0].revision,2);
  await mutate('proposal_restore',{id,requirementId:'PA-002'},400); // restores a cycle
  await mutate('proposal_restore',{id,requirementId:'PA-001'});await mutate('proposal_delete',{id,requirementId:'PA-001'});await mutate('proposal_restore',{id,requirementId:'PA-001'});
 });
 await t.test('imports cannot forge revisions, additions, deletions or applied outcomes',async()=>{
  for(const change of [w=>w.requirements.push({...w.requirements[0],id:'PA-099'}),w=>w.requirements.pop(),w=>{w.requirements[0].revision++;w.requirements[0].title='Forged accepted edit';}]){const imported=structuredClone(doc);change(imported);const before=structuredClone(doc);const error=await mutate('import',{workspace:imported},400);assert.match(error.error,/proposal/i);assert.deepEqual(await read(),before);}
  const imported=structuredClone(doc);imported.proposals[0].status='Applied';await mutate('import',{workspace:imported});assert.equal(doc.proposals[0].status,'Draft');
 });
 assert.deepEqual({requirements:doc.requirements,version:doc.requirementsVersion,baselines:doc.baselines,evidence:doc.evidence},accepted);
 await t.test('atomic endpoint creates a proposal once, rejects stale tokens and preserves lifecycle on Apply',async()=>{
  const args={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),new_proposal:{title:'Atomic API destination'},operations:[{op:'add',client_ref:'new',requirement:input('New staged requirement')}]};
  doc=await request(args,200,'/api/proposal-authoring');const saved=structuredClone(doc);assert.deepEqual(await request(args,200,'/api/proposal-authoring'),saved);assert.deepEqual(await read(),saved);
  await request({...args,idempotency_key:crypto.randomUUID()},409,'/api/proposal-authoring');
  const pid=doc.proposals[0].id;await mutate('proposal_submit',{id:pid});await mutate('requirements',{proposal_id:pid,requirements:[input('Submitted cannot edit')]},400);const before=doc.requirementsVersion;await mutate('proposal_review',{id:pid,review:{decision:'apply'}});assert.equal(doc.requirementsVersion,before+1);assert.equal(doc.requirements.at(-1).status,'Approved');assert.deepEqual(doc.baselines[0].requirements,doc.requirements);
 });
});
