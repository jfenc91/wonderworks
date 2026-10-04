import test from 'node:test';
import assert from 'node:assert/strict';
import {createProposal,editProposalRequirement,deleteProposalRequirement,restoreProposalRequirement,submitProposal,reviewProposal,rebaseProposal,isStale,requirementChanges,setContent,snapshot,sameRequirement} from '../lib/workflow.ts';
import {setSnapshotImplementation} from '../lib/snapshot-implementation.ts';
import {captureRequirementHistory,requirementHistory} from '../lib/requirement-history.ts';
import {reconcileLifecycle,lifecycleState,pendingRequirements,proposalLifecycle} from '../lib/lifecycle.ts';
import {callTool,stage} from '../lib/mcp/service.ts';
import {reconcileWorkspace} from '../lib/requirements.ts';
const actor={id:'reviewer'};
const workspace=()=>({id:'lifecycle',prefix:'LC',name:'Lifecycle QA',version:0,requirementsVersion:1,requirements:[],sections:[{id:'s',title:'Core behavior',description:''}],baselines:[],evidence:[],history:[],proposals:[],repositories:[]});
const input=(extra={})=>({section:'s',title:'Observable behavior',description:'The system shall preserve the revision.',criteria:['The result is observable.'],priority:'High',parameters:{},links:[],...extra});
function change(d,source,fn,date){const before=structuredClone(d);const result=fn();captureRequirementHistory(before,d,{source,actor,date});return result;}
function add(d,n=4){const p=createProposal(d,{title:'Accept initial behavior'});for(let i=0;i<n;i++)change(d,'stage',()=>editProposalRequirement(d,p.id,input({title:'Behavior '+i})));accept(d,p);return p;}
function accept(d,p){change(d,'proposal_review',()=>{submitProposal(d,p.id);reviewProposal(d,p.id,{decision:'apply'});});}
function commit(d,id,value='a'.repeat(40)){return change(d,'set_snapshot_implementation',()=>setSnapshotImplementation(d,id,value?{commit_id:value}:null,actor));}
const immutable=d=>JSON.stringify({requirements:d.requirements.map(({status,...r})=>r),sections:d.sections,baselines:d.baselines,proposals:d.proposals,evidence:d.evidence,version:d.requirementsVersion});

test('mixed Apply approves only changed normative revisions and retains latest unchanged implementation',()=>{
 const d=workspace();add(d);commit(d,'BL-001');const creation=requirementHistory(d,'LC-001').lifecycle.created;
 const p=createProposal(d,{title:'Mixed revision batch'});change(d,'stage',()=>editProposalRequirement(d,p.id,{...d.requirements[0],title:'Changed implementation'}));
 change(d,'stage',()=>editProposalRequirement(d,p.id,input({title:'New normative behavior'})));
 change(d,'stage',()=>editProposalRequirement(d,p.id,input({kind:'information',title:'Editorial overview',status:'Approved',criteria:[],summarizes:[{requirement_id:'LC-001',reviewed_revision:2}]})));
 deleteProposalRequirement(d,p.id,'LC-003');
 assert.equal(d.requirements[0].status,'Implemented');assert.equal(pendingRequirements(d,p)[0].status,'Draft');assert.equal(proposalLifecycle(d,p)[0].expected_on_apply,'Approved');
 // Simulate a copied status before a concurrent implementation reference.
 p.requirements.find(r=>r.id==='LC-002').status='Draft';p.baseRequirements.find(r=>r.id==='LC-002').status='Draft';
 assert.equal(isStale(d,p),false);accept(d,p);
 assert.deepEqual(d.requirements.map(r=>[r.id,r.revision,r.status]),[['LC-001',2,'Approved'],['LC-002',1,'Implemented'],['LC-004',1,'Implemented'],['LC-005',1,'Approved'],['LC-006',1,'Approved']]);
 assert.deepEqual(d.baselines[0].requirements,d.requirements);assert.equal(d.requirementsVersion,3);assert.deepEqual(requirementHistory(d,'LC-001').lifecycle.created,creation);
 assert.ok(!requirementHistory(d,'LC-003').items[0].lifecycle?.approval);
 assert.ok(!requirementHistory(d,'LC-006').items[0].lifecycle?.implementation);
 const next=createProposal(d,{title:'Another accepted revision'});editProposalRequirement(d,next.id,{...d.requirements[0],priority:'Critical'});accept(d,next);
 const h=requirementHistory(d,'LC-001');assert.equal(h.lifecycle.last_approved.revision,3);assert.equal(h.items[0].before.status,'Approved');assert.equal(h.items[0].after.status,'Approved');assert.ok(h.items[0].lifecycle.approval);assert.equal(d.requirements.find(r=>r.id==='LC-006').summarizes[0].reviewed_revision,2);
});
test('pending operations, metadata refresh, no-op and restoration create no accepted lifecycle or content staleness',()=>{
 const d=workspace();add(d,2);const p=createProposal(d,{title:'Preserved working proposal'}),before=setContent(d);commit(d,'BL-001');
 assert.equal(setContent(d),before);assert.equal(isStale(d,p),false);assert.equal(requirementChanges(p.baseRequirements,p.requirements).length,0);assert.equal(pendingRequirements(d,p)[0].status,'Implemented');
 const accepted=JSON.stringify(d.requirements),history=JSON.stringify(d.requirementHistory);
 editProposalRequirement(d,p.id,{...p.requirements[0],title:'Pending behavior'});assert.equal(p.requirements[0].revision,2);submitProposal(d,p.id);reviewProposal(d,p.id,{decision:'request_changes'});rebaseProposal(d,p.id,{});
 restoreProposalRequirement(d,p.id,'LC-001');assert.equal(p.requirements[0].revision,1);assert.equal(requirementChanges(p.baseRequirements,p.requirements).length,0);
 editProposalRequirement(d,p.id,{...p.requirements[0],tags:[' SPACE ','space']});editProposalRequirement(d,p.id,{...p.requirements[0],tags:[]});assert.equal(p.requirements[0].revision,1);
 assert.equal(JSON.stringify(d.requirements),accepted);assert.equal(JSON.stringify(d.requirementHistory),history);
});
test('matching any snapshot, mixed revisions, multiple supports, replacements and last clear preserve immutable records',()=>{
 const d=workspace();add(d,3);commit(d,'BL-001');const p=createProposal(d,{title:'Advance A delete C'});editProposalRequirement(d,p.id,{...d.requirements[0],title:'A revision two'});deleteProposalRequirement(d,p.id,'LC-003');accept(d,p);snapshot(d,'Carried current revisions');
 const protectedBefore=immutable(d),count=requirementHistory(d,'LC-002').items.filter(e=>e.lifecycle?.implementation).length;
 commit(d,'BL-001','b'.repeat(64));assert.deepEqual(d.requirements.map(r=>r.status),['Approved','Implemented']);
 commit(d,'BL-003');commit(d,'BL-002');assert.equal(lifecycleState(d,d.requirements[0]).supports.length,2);assert.equal(lifecycleState(d,d.requirements[1]).supports.length,3);
 assert.equal(requirementHistory(d,'LC-002').items.filter(e=>e.lifecycle?.implementation).length,count);
 const noOp=JSON.stringify(d);assert.equal(commit(d,'BL-002',' AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA '),false);assert.equal(JSON.stringify(d),noOp);
 commit(d,'BL-003',null);assert.equal(d.requirements[0].status,'Implemented');commit(d,'BL-002',null);assert.equal(d.requirements[0].status,'Approved');assert.equal(d.requirements[1].status,'Implemented');commit(d,'BL-001',null);assert.equal(d.requirements[1].status,'Approved');
 assert.equal(immutable(d),protectedBefore);const h=requirementHistory(d,'LC-001');assert.match(h.items[0].lifecycle.reason,/Lost last/);assert.equal(h.lifecycle.last_approved.revision,2);
 assert.ok(h.items[0].lifecycle.commitId);assert.equal(h.items[0].before.revision,h.items[0].after.revision);
});
test('same ID and revision with different content, pending-only items and Information are ineligible',()=>{
 const d=workspace();add(d,2);const b=d.baselines[0];b.requirements[0].title='Different authored content';const p=createProposal(d,{title:'Only pending addition'});editProposalRequirement(d,p.id,input());
 d.requirements.push({...input({kind:'information',criteria:[],status:'Draft'}),id:'LC-010',revision:1});b.requirements.push(structuredClone(d.requirements.at(-1)));commit(d,b.id);
 assert.deepEqual(d.requirements.map(r=>r.status),['Approved','Implemented','Draft']);assert.equal(p.requirements.at(-1).status,'Draft');
 assert.throws(()=>commit(d,'BL-999'),{code:'NOT_FOUND'});
 const other=workspace();add(other,1);assert.equal(other.requirements[0].status,'Approved');
});
test('system-maintained status rejects overrides across staged and imported content and permits unchanged echoes',()=>{
 const d=workspace();const p=createProposal(d,{title:'Validate system status'});
 for(const status of ['Approved','Implemented'])assert.throws(()=>stage(d,p.id,[{op:'add',client_ref:'x',requirement:input({status})}]),/system-maintained/);
 editProposalRequirement(d,p.id,input({status:'Draft'}));accept(d,p);const next=createProposal(d,{title:'Edit accepted status'});
 for(const status of ['Draft','Implemented'])assert.throws(()=>editProposalRequirement(d,next.id,{...d.requirements[0],status}),/system-maintained/);
 editProposalRequirement(d,next.id,{...d.requirements[0],title:'Valid legacy echo'});assert.equal(next.requirements[0].status,'Draft');
 const forged=structuredClone(d);forged.requirements[0].status='Implemented';assert.throws(()=>reconcileWorkspace(d,forged),/system-maintained/);
});
test('legacy reconciliation proves changed accepted revisions only, preserves unknown facts and reports truthful dates',()=>{
 const d=workspace();add(d,4);const p=createProposal(d,{title:'Change exactly one'});editProposalRequirement(d,p.id,{...d.requirements[0],title:'Known accepted revision'});accept(d,p);
 delete d.requirementLifecycle;delete d.requirementHistory;
 // Only CP-002's changed revision has acceptance provenance.
 d.proposals=d.proposals.filter(v=>v.id===p.id);for(const r of d.requirements)r.status='Draft';d.requirements[2].status='Implemented';d.requirements[3].revision++;
 d.snapshotImplementations={'BL-001':{implementation_commit:{commit_id:'a'.repeat(40)},updated_at:'2026-01-03T00:00:00.000Z',actor:{id:null},history:[]}};
 const original=immutable(d);const results=change(d,'reconcile_lifecycle',()=>reconcileLifecycle(d),'2026-10-01T00:00:00.000Z');assert.ok(results.changed);
 assert.deepEqual(d.requirements.map(r=>r.status),['Approved','Implemented','Implemented','Draft']);assert.equal(immutable(d),original);
 assert.ok(lifecycleState(d,d.requirements[2]).missing_provenance.some(v=>/Legacy/.test(v)));assert.ok(!lifecycleState(d,d.requirements[1]).acceptance);
 let h=requirementHistory(d,'LC-001');assert.equal(h.lifecycle.last_approved.date,d.baselines[0].date);assert.equal(h.lifecycle.created.state,'unknown');assert.equal(h.lifecycle.last_changed.state,'unknown');assert.ok(h.items[0].lifecycle.recovered);
 assert.equal(requirementHistory(d,'LC-002').lifecycle.last_implemented.date,'2026-01-03T00:00:00.000Z');
 const once=JSON.stringify(d);assert.equal(change(d,'reconcile_lifecycle',()=>reconcileLifecycle(d)).changed,false);assert.equal(JSON.stringify(d),once);
 commit(d,'BL-001',null);assert.equal(d.requirements[1].status,'Approved');assert.equal(d.requirements[2].status,'Implemented');
 const unknown=workspace();add(unknown,1);delete unknown.requirementLifecycle;delete unknown.requirementHistory;delete unknown.baselines[0].requirementsVersion;unknown.requirements[0].status='Draft';change(unknown,'reconcile_lifecycle',()=>reconcileLifecycle(unknown));h=requirementHistory(unknown,'LC-001');assert.equal(h.lifecycle.last_approved.state,'unknown');assert.equal(h.lifecycle.last_approved.date,null);assert.equal(unknown.requirements[0].status,'Approved');
});
test('current MCP read models expose coherent lifecycle, pending expectations and original frozen statuses without writing',async()=>{
 const d=workspace();add(d,1);const p=createProposal(d,{title:'Pending next revision'});editProposalRequirement(d,p.id,{...d.requirements[0],title:'Next content'});commit(d,'BL-001');
 const original=JSON.stringify(d),store={read:async()=>structuredClone(d),commit:()=>assert.fail('read wrote')};
 const call=(name,args={})=>callTool(store,name,{project_id:d.id,...args},actor,'read');
 const item=await call('get_requirement',{requirement_id:'LC-001'});assert.equal(item.requirement.status,'Implemented');assert.equal(item.lifecycle_state.supports[0].baseline_id,'BL-001');
 const list=await call('list_requirements');assert.equal(list.items[0].lifecycle_state.status,'Implemented');
 const proposal=await call('get_proposal',{proposal_id:p.id});assert.equal(proposal.proposal.requirements[0].status,'Draft');assert.equal(proposal.proposal.lifecycle[0].context,'pending');assert.equal(proposal.proposal.stale,false);assert.ok(!proposal.proposal.changes[0].fields.includes('status'));
 assert.equal((await call('get_snapshot',{baseline_id:'BL-001'})).snapshot.requirements[0].status,'Approved');assert.equal(JSON.stringify(d),original);
});
test('every authored field invalidates old implementation while editorial status alone creates no authored revision',()=>{
 const updates=[{title:'Changed title'},{description:'The system shall preserve the revision. '},{criteria:['A changed measured outcome.']},{priority:'Critical'},{tags:['security']},{parameters:{limit:10}},{links:['LC-002']},{body_format:'markdown'},{diagrams:[{id:'flow',language:'mermaid',source:'flowchart LR\n A-->B',title:'Flow',alt:'A leads to B',position:0}]},{section:'second'}];
 for(const update of updates){const d=workspace();d.sections.push({id:'second',title:'Other section',description:''});add(d,2);commit(d,'BL-001');const p=createProposal(d,{title:'Author one field'});editProposalRequirement(d,p.id,{...d.requirements[0],...update});accept(d,p);assert.equal(d.requirements[0].revision,2,JSON.stringify(update));assert.equal(d.requirements[0].status,'Approved');commit(d,'BL-001','b'.repeat(40));assert.equal(d.requirements[0].status,'Approved');commit(d,'BL-002');assert.equal(d.requirements[0].status,'Implemented');}
 const d=workspace(),p=createProposal(d,{title:'Editorial information'});editProposalRequirement(d,p.id,input({kind:'information',criteria:[],status:'Draft'}));accept(d,p);const version=d.requirementsVersion,next=createProposal(d,{title:'Editorial approval only'});editProposalRequirement(d,next.id,{...d.requirements[0],status:'Approved'});accept(d,next);assert.equal(d.requirements[0].revision,1);assert.equal(d.requirementsVersion,version);assert.equal(d.requirements[0].status,'Approved');commit(d,d.baselines[0].id);assert.equal(d.requirements[0].status,'Approved');
});
