import test from 'node:test';
import assert from 'node:assert/strict';
import {captureRequirementHistory,requirementHistory,requirementHistoryPage} from '../lib/requirement-history.ts';
import {upsert,record,reconcileWorkspace,nextId} from '../lib/requirements.ts';
import {createProposal,editProposalRequirement,deleteProposalRequirement,submitProposal,reviewProposal,rebaseProposal,snapshot,setContent} from '../lib/workflow.ts';
import {projectGuidance} from '../lib/agent-guidance.ts';
import {toolMap} from '../lib/mcp/contracts.ts';
const input=(extra={})=>({section:'section',title:'Sample requirement',description:'The system shall preserve its exact history.',criteria:['The result is observable.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
const workspace=()=>({id:'history-test',prefix:'HT',name:'History QA',version:0,requirementsVersion:1,sections:[{id:'section',title:'Behavior',description:''}],requirements:[],baselines:[],evidence:[],history:[],proposals:[],repositories:[]});
let clock=0;
function commit(doc,source,mutate,date=new Date(Date.UTC(2026,9,4,0,0,clock++)).toISOString()){
  const before=structuredClone(doc);mutate(doc);
  if(setContent(before)!==setContent(doc)&&before.requirementsVersion===doc.requirementsVersion)doc.requirementsVersion++;
  captureRequirementHistory(before,doc,{source,date,actor:{id:'trusted-user',reportedClientName:'untrusted label'}});doc.version++;
}
test('exact field diffs, actor provenance, no-ops and revision-specific lifecycle cycles',()=>{
  const doc=workspace();commit(doc,'requirements',d=>upsert(d,input()));const id=doc.requirements[0].id;
  const created=requirementHistory(doc,id).lifecycle.created;
  for(const change of [{section:'second'},{title:'New title'},{description:'A replacement description for history.'},{criteria:['First criterion','Second criterion']},{priority:'Critical'},{parameters:{power:5,enabled:true}},{tags:['security','mcp']},{status:'Approved'},{status:'Draft'},{status:'Approved'},{status:'Implemented'}]){
    const old=structuredClone(doc.requirements[0]);doc.sections.push({id:'second',title:'Second section',description:''});
    commit(doc,'requirements',d=>upsert(d,{...old,...change}));
    const event=requirementHistory(doc,id).items[0];assert.deepEqual(event.before,old);assert.deepEqual(event.after,doc.requirements[0]);assert.deepEqual(event.fields,Object.keys(change));assert.equal(event.actor.id,'trusted-user');assert.equal(event.actor.reportedClientName,'untrusted label');
  }
  commit(doc,'requirements',d=>upsert(d,input({title:'Dependency target'})));const dependency=doc.requirements[1].id;
  commit(doc,'requirements',d=>upsert(d,{...d.requirements[0],links:[dependency]}));assert.deepEqual(requirementHistory(doc,id).items[0].fields,['links']);
  const history=requirementHistory(doc,id);assert.deepEqual(history.lifecycle.created,created);assert.equal(history.lifecycle.last_change_accepted.state,'not_recorded');assert.notEqual(history.lifecycle.first_approved.date,history.lifecycle.last_approved.date);assert.equal(history.lifecycle.last_approved.revision,11);assert.equal(history.lifecycle.last_implemented.revision,12);
  commit(doc,'requirements',d=>upsert(d,{...d.requirements[0],parameters:{enabled:true,power:5},tags:[' MCP ','security','MCP']}));assert.deepEqual(requirementHistory(doc,id),history);
  assert.equal(requirementHistory(doc,dependency).items.length,1);
});
test('initial statuses and a direct transition to Implemented never invent approval',()=>{
  for(const status of ['Draft','Approved','Implemented']){
    const doc=workspace();commit(doc,'requirements',d=>upsert(d,input({status})));
    const life=requirementHistory(doc,'HT-001').lifecycle;
    assert.equal(life.first_approved.state,status==='Approved'?'known':'not_recorded');assert.equal(life.last_implemented.state,status==='Implemented'?'known':'not_recorded');
  }
  const doc=workspace();commit(doc,'requirements',d=>upsert(d,input()));commit(doc,'requirements',d=>upsert(d,{...d.requirements[0],status:'Implemented'}));assert.equal(requirementHistory(doc,'HT-001').lifecycle.first_approved.state,'not_recorded');
});
test('pending creation retains original time through edits, rebase, review and atomic multi-change application',()=>{
  const doc=workspace();commit(doc,'requirements',d=>{upsert(d,input());upsert(d,input({title:'Delete this requirement'}));});
  commit(doc,'proposal',d=>createProposal(d,{title:'A batch of changes'}));
  commit(doc,'proposal_requirement',d=>editProposalRequirement(d,'CP-001',input({title:'New proposed requirement'})));
  const created=requirementHistory(doc,'HT-003').lifecycle.created;assert.equal(requirementHistory(doc,'HT-003').presence,'pending');assert.equal(created.state,'known');
  commit(doc,'proposal_requirement',d=>editProposalRequirement(d,'CP-001',{...d.proposals[0].requirements[0],tags:['mcp']}));
  commit(doc,'proposal_requirement',d=>editProposalRequirement(d,'CP-001',{...d.proposals[0].requirements[2],title:'Edited pending requirement'}));
  commit(doc,'proposal_delete',d=>deleteProposalRequirement(d,'CP-001','HT-002'));
  commit(doc,'proposal_submit',d=>submitProposal(d,'CP-001'));
  commit(doc,'proposal_review',d=>reviewProposal(d,'CP-001',{decision:'request_changes'}));
  commit(doc,'proposal_rebase',d=>rebaseProposal(d,'CP-001',{}));
  assert.equal(requirementHistory(doc,'HT-001').items.length,1);assert.equal(requirementHistory(doc,'HT-003').items.length,1);
  commit(doc,'proposal_submit',d=>submitProposal(d,'CP-001'));
  const acceptedAt='2026-10-05T10:00:00.000Z';commit(doc,'proposal_review',d=>reviewProposal(d,'CP-001',{decision:'apply',note:'Reviewed together'}),acceptedAt);
  for(const id of ['HT-001','HT-002','HT-003']){
    const history=requirementHistory(doc,id),event=history.items[0];assert.equal(event.source,'proposal_apply');assert.equal(event.date,acceptedAt);assert.equal(event.proposalId,'CP-001');assert.equal(event.snapshotId,'BL-001');assert.equal(event.reviewNote,'Reviewed together');assert.equal(history.lifecycle.last_change_accepted.date,acceptedAt);assert.equal(history.lifecycle.first_approved.state,'not_recorded');
  }
  assert.deepEqual(requirementHistory(doc,'HT-003').lifecycle.created,created);assert.equal(requirementHistory(doc,'HT-002').presence,'deleted');
  assert.deepEqual(doc.history[0].requirementIds,['HT-001','HT-002','HT-003']);
  commit(doc,'requirements',d=>upsert(d,{...d.requirements[0],title:'Later direct revision'}));
  const life=requirementHistory(doc,'HT-001').lifecycle;assert.equal(life.last_change_accepted.revision,2);assert.equal(life.last_changed.revision,3);
});
test('rejected proposed additions remain uncommitted and deleted IDs cannot be reused',()=>{
  const doc=workspace();commit(doc,'proposal',d=>createProposal(d,{title:'Rejected addition'}));commit(doc,'proposal_requirement',d=>editProposalRequirement(d,'CP-001',input()));commit(doc,'proposal_submit',d=>submitProposal(d,'CP-001'));commit(doc,'proposal_review',d=>reviewProposal(d,'CP-001',{decision:'reject'}));
  const h=requirementHistory(doc,'HT-001');assert.equal(h.items.length,1);assert.equal(h.lifecycle.last_change_accepted.state,'not_recorded');assert.equal(h.lifecycle.last_changed.state,'not_recorded');
  const second=workspace();commit(second,'requirements',d=>upsert(d,input()));commit(second,'delete',d=>{d.requirements=[];record(d,'Deleted');});delete second.nextSequence;assert.equal(nextId(second),'HT-002');assert.equal(requirementHistory(second,'HT-001').presence,'deleted');
});
test('durability beyond Activity retention, pagination, concurrent changes, project isolation and discovery',async()=>{
  const doc=workspace();commit(doc,'requirements',d=>upsert(d,input()));
  for(let i=0;i<104;i++)commit(doc,'requirements',d=>upsert(d,{...d.requirements[0],title:'Revision '+i}),'2026-10-04T00:00:00.000Z');
  for(let i=0;i<510;i++)record(doc,'Unrelated activity '+i);
  const saved=JSON.stringify(doc),restored=JSON.parse(saved);assert.equal(restored.history.length,500);assert.equal(requirementHistory(restored,'HT-001').items.length,105);
  const one=await requirementHistoryPage(restored,'HT-001');assert.equal(one.items.length,50);
  const two=await requirementHistoryPage(restored,'HT-001',{cursor:one.next_cursor});const three=await requirementHistoryPage(restored,'HT-001',{cursor:two.next_cursor});assert.equal(three.items.length,5);assert.equal(new Set([...one.items,...two.items,...three.items].map(e=>e.id)).size,105);assert.equal(one.items[0].sequence,105);
  toolMap.get('get_requirement_history').output.parse({...one,...projectGuidance(restored,'get_requirement_history',{},one)});assert.equal(JSON.stringify(restored),saved);
  await assert.rejects(()=>requirementHistoryPage({...restored,id:'another-project'},'HT-001',{cursor:one.next_cursor}),{code:'INVALID_CURSOR'});
  await assert.rejects(()=>requirementHistoryPage(restored,'HT-999'),{code:'NOT_FOUND'});
  for(const limit of [0,101,1.5])await assert.rejects(()=>requirementHistoryPage(restored,'HT-001',{limit}),{code:'VALIDATION_ERROR'});
  commit(restored,'requirements',d=>upsert(d,{...d.requirements[0],title:'Concurrent update'}));await assert.rejects(()=>requirementHistoryPage(restored,'HT-001',{cursor:one.next_cursor}),{code:'RESTART_REQUIRED'});
});
// These fixtures represent historical imports already stored before proposal-only authoring.
test('legacy observations, import gaps and untrusted history preserve frozen data and local provenance',()=>{
  const doc=workspace();upsert(doc,input({status:'Approved'}));snapshot(doc,'Legacy observation');
  const frozen=JSON.stringify(doc.baselines),before=JSON.stringify(doc),old=requirementHistory(doc,'HT-001');
  assert.equal(old.coverage.state,'partial');assert.equal(old.lifecycle.created.state,'unknown');assert.equal(old.lifecycle.first_approved.state,'unknown');assert.equal(old.coverage.first_observed.snapshotId,'BL-001');assert.equal(JSON.stringify(doc),before);assert.deepEqual(requirementHistory(doc,'HT-001'),old);
  commit(doc,'requirements',d=>upsert(d,{...d.requirements[0],title:'Locally recorded revision'}));const local=structuredClone(doc.requirementHistory);
  const incoming=structuredClone(doc);incoming.requirements[0].revision+=4;incoming.requirements[0].title='Imported newer revision';incoming.requirementHistory={'HT-001':{complete:true,events:[{date:'1900-01-01',actor:{id:'forged'}}]}};
  commit(doc,'import',d=>{d.requirements=incoming.requirements;});assert.deepEqual(doc.requirementHistory['HT-001'].events[0],local['HT-001'].events[0]);const h=requirementHistory(doc,'HT-001');assert.equal(h.items[0].source,'import');assert.equal(h.items[0].revisionGap,true);assert.equal(h.lifecycle.created.state,'unknown');assert.equal(h.lifecycle.last_approved.state,'unknown');assert.equal(JSON.stringify(doc.baselines),frozen);
  const omitted=structuredClone(doc);delete omitted.requirementHistory;const events=structuredClone(doc.requirementHistory);commit(doc,'import',d=>reconcileWorkspace(d,omitted));assert.deepEqual(doc.requirementHistory,events);
});
test('a later imported revision gap preserves an already-known first approval',()=>{
  const doc=workspace();commit(doc,'requirements',d=>upsert(d,input({status:'Approved'})));
  const first=requirementHistory(doc,'HT-001').lifecycle.first_approved;
  const incoming=structuredClone(doc);incoming.requirements[0].revision+=4;incoming.requirements[0].title='Imported after approval';
  commit(doc,'import',d=>{d.requirements=incoming.requirements;});
  assert.equal(requirementHistory(doc,'HT-001').coverage.state,'partial');assert.deepEqual(requirementHistory(doc,'HT-001').lifecycle.first_approved,first);
});
