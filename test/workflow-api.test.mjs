import {acceptRequirements} from './fixtures/accepted-requirements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

// Run against the local preview only: node --test test/workflow-api.test.mjs
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error('Workflow tests must use a local disposable database');
async function request(body,status=200){
  const response=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
}
test('repository links, versioned snapshots, reviewed batches, and concurrent changes',async t=>{
  let doc=await request({action:'project',name:'Workflow QA (local)',prefix:'QA'});
  const accept=async({requirements})=>doc=await acceptRequirements(doc,requirements,request);
  const mutate=async(action,payload={},status=200)=>{
    const result=await request({project:doc.id,version:doc.version,action,...payload},status);
    if(status===200)doc=result;return result;
  };
  const read=async()=>{const response=await fetch(origin+'/api/workspace?project='+doc.id);assert.equal(response.status,200);return response.json();};
  await mutate('section',{section:{title:'Core behavior',description:'Local workflow verification'}});
  const input=(title,links=[])=>({section:doc.sections[0].id,title,description:'A measurable behavior for the workflow test.',criteria:['The behavior is observable.'],priority:'High',status:'Draft',parameters:{enabled:true},links});
  await accept({requirements:[input('Keep this requirement'),input('Revise this requirement'),input('Remove this requirement')]});
  const originalRequirements=structuredClone(doc.requirements),originalVersion=doc.requirementsVersion;
  let proposalId;
  await t.test('repository metadata persists without changing the requirement-set version',async()=>{
    await mutate('repository',{repository:{name:'Application code',url:'https://github.com/example/application',branch:'main'}});
    assert.equal(doc.requirementsVersion,originalVersion);assert.equal((await read()).repositories[0].branch,'main');
    await mutate('repository',{repository:{name:'Unsafe link',url:'javascript:alert(1)',branch:''}},400);
    await mutate('repository',{repository:{name:'Credential URL',url:'https://user:secret@example.com/repository',branch:''}},400);
  });
  await t.test('snapshots preserve exact content and repository context',async()=>{
    await mutate('baseline',{name:'Before the batch'});
    assert.equal(doc.baselines[0].requirementsVersion,originalVersion);
    assert.deepEqual(doc.baselines[0].requirements,originalRequirements);
    assert.equal(doc.baselines[0].repositories[0].branch,'main');
  });
  const originalSnapshot=structuredClone(doc.baselines[0]);
  await t.test('draft batches stage additions, revisions and deletions without changing current requirements',async()=>{
    await mutate('proposal',{proposal:{title:'Improve the requirement set',description:'Exercise the complete review workflow.'}});proposalId=doc.proposals[0].id;
    await mutate('proposal_requirement',{id:proposalId,requirement:{...doc.requirements[1],title:'Revised by proposal'}});
    await mutate('proposal_delete',{id:proposalId,requirementId:doc.requirements[2].id});
    await mutate('proposal_requirement',{id:proposalId,requirement:input('New requirement in proposal',[doc.requirements[1].id])});
    assert.deepEqual(doc.requirements,originalRequirements);assert.equal(doc.requirementsVersion,originalVersion);
    assert.equal(doc.proposals[0].requirements.find(r=>r.id===originalRequirements[1].id).revision,2);
    await mutate('proposal_review',{id:proposalId,review:{decision:'apply'}},400);
    await mutate('proposal_submit',{id:proposalId});
    await mutate('proposal_requirement',{id:proposalId,requirement:{...originalRequirements[0],title:'Cannot edit a submitted proposal'}},400);
  });
  await t.test('stale proposals cannot overwrite latest changes and refresh keeps unrelated edits',async()=>{
    await accept({requirements:[{...doc.requirements[0],title:'Latest independent edit'}]});
    await mutate('proposal_review',{id:proposalId,review:{decision:'apply'}},400);
    await mutate('proposal_rebase',{id:proposalId,resolutions:{}});
    assert.equal(doc.proposals.find(p=>p.id===proposalId).status,'Draft');
    assert.equal(doc.proposals.find(p=>p.id===proposalId).requirements[0].title,'Latest independent edit');
    assert.equal(doc.proposals.find(p=>p.id===proposalId).requirements[1].title,'Revised by proposal');
    assert.equal(doc.proposals.find(p=>p.id===proposalId).baseVersion,doc.requirementsVersion);
  });
  await t.test('overlapping edits require an explicit conflict resolution',async()=>{
    await accept({requirements:[{...doc.requirements[1],title:'Conflicting latest edit'}]});
    const before=structuredClone(doc);
    await mutate('proposal_rebase',{id:proposalId,resolutions:{}},400);
    assert.deepEqual((await read()).proposals,before.proposals);
    await mutate('proposal_rebase',{id:proposalId,resolutions:{[originalRequirements[1].id]:'proposed'}});
    assert.equal(doc.proposals.find(p=>p.id===proposalId).requirements[1].title,'Revised by proposal');
    assert.equal(doc.proposals.find(p=>p.id===proposalId).requirements[1].revision,doc.requirements[1].revision+1);
    await mutate('proposal_submit',{id:proposalId});
  });
  await t.test('applying is atomic, advances the set version once and freezes the result',async()=>{
    const version=doc.requirementsVersion;
    await mutate('proposal_review',{id:proposalId,review:{decision:'apply',note:'Reviewed the full batch.'}});
    assert.equal(doc.requirementsVersion,version+1);assert.equal(doc.proposals.find(p=>p.id===proposalId).status,'Applied');
    assert.equal(doc.proposals.find(p=>p.id===proposalId).appliedVersion,doc.requirementsVersion);
    assert.equal(doc.proposals.find(p=>p.id===proposalId).appliedSnapshot,doc.baselines[0].id);
    assert.deepEqual(doc.baselines[0].requirements,doc.requirements);
    assert.deepEqual(doc.baselines.find(b=>b.id===originalSnapshot.id),originalSnapshot);
    assert.equal(doc.requirements.length,3);
    assert.equal(doc.requirements[0].title,'Latest independent edit');
    assert.ok(!doc.requirements.some(r=>r.id===originalRequirements[2].id));
    await mutate('proposal_review',{id:proposalId,review:{decision:'apply'}},400);
    assert.deepEqual((await read()).requirements,doc.requirements);
  });
  await t.test('request changes and rejection preserve the latest set',async()=>{
    const before=structuredClone(doc.requirements);
    await mutate('proposal',{proposal:{title:'A second proposed update'}});const id=doc.proposals[0].id;
    await mutate('proposal_requirement',{id,requirement:{...doc.requirements[0],title:'Needs more discussion'}});
    await mutate('proposal_submit',{id});
    await mutate('proposal_review',{id,review:{decision:'request_changes',note:'Please clarify the criterion.'}});
    assert.equal(doc.proposals[0].status,'Draft');assert.equal(doc.proposals[0].reviewNote,'Please clarify the criterion.');
    await mutate('proposal_submit',{id});await mutate('proposal_review',{id,review:{decision:'reject',note:'Keep the current behavior.'}});
    assert.equal(doc.proposals[0].status,'Rejected');assert.deepEqual(doc.requirements,before);
    await mutate('proposal_rebase',{id,resolutions:{}},400);
  });
  await t.test('invalid batch dependencies are rejected and staging can be undone',async()=>{
    await mutate('proposal',{proposal:{title:'Dependency validation'}});const id=doc.proposals[0].id;
    const dependent=doc.requirements.find(r=>r.links.length),target=dependent.links[0];
    await mutate('proposal_delete',{id,requirementId:target},400);
    await mutate('proposal_submit',{id},400);
    await mutate('proposal_restore',{id,requirementId:target});
    await mutate('proposal_submit',{id},400); // now an empty diff
    const a=doc.proposals[0].requirements.find(r=>r.id===target);
    await mutate('proposal_requirement',{id,requirement:{...a,links:[dependent.id]}},400);
    await mutate('proposal_submit',{id},400); // dependency cycle
    await mutate('proposal_restore',{id,requirementId:target});
    assert.deepEqual((await read()).requirements,doc.requirements);
  });
  await t.test('workspace concurrency protects repository and proposal updates too',async()=>{
    const oldVersion=doc.version;
    await mutate('repository',{repository:{...doc.repositories[0],branch:'release'}});
    await request({project:doc.id,version:oldVersion,action:'proposal',proposal:{title:'Stale session'}},409);
    assert.equal((await read()).version,doc.version);
    assert.equal(doc.baselines.find(b=>b.id===originalSnapshot.id).repositories[0].branch,'main');
  });
  console.log('LOCAL_WORKFLOW_QA_PROJECT='+doc.id);
});

test('IDs are reserved across proposals and empty sets can be snapshotted',async()=>{
  let doc=await request({action:'project',name:'Empty set QA (local)',prefix:'EQ'});
  const accept=async({requirements})=>doc=await acceptRequirements(doc,requirements,request);
  async function mutate(action,data){doc=await request({action,project:doc.id,version:doc.version,...data});}
  await mutate('baseline',{name:'Empty starting point'});assert.deepEqual(doc.baselines[0].requirements,[]);
  await mutate('section',{section:{title:'Behavior',description:''}});
  const req={section:doc.sections[0].id,title:'Reserved identifier',description:'A requirement introduced through a proposal.',criteria:['The ID is never reused.'],priority:'High',status:'Draft'};
  await mutate('proposal',{proposal:{title:'First reserved ID'}});await mutate('proposal_requirement',{id:doc.proposals[0].id,requirement:req});
  const first=doc.proposals[0].requirements[0].id;
  await mutate('proposal',{proposal:{title:'Second reserved ID'}});await mutate('proposal_requirement',{id:doc.proposals[0].id,requirement:req});
  const second=doc.proposals[0].requirements[0].id;
  await accept({requirements:[req]});
  assert.equal(new Set([first,second,doc.requirements[0].id]).size,3);
});
