import test from 'node:test';
import assert from 'node:assert/strict';
import {guidanceDefaults,guidanceOverridesInput,effectiveGuidance,boundedGuidance,initializationGuidance,projectGuidance} from '../lib/agent-guidance.ts';
import {toolMap} from '../lib/mcp/contracts.ts';
import {workspace,apply} from './fixtures/snapshot-workspace.mjs';
const chars=s=>Array.from(s).length;
const count=r=>chars(r.workflow_guidance?.reminder??'')+chars(r.workflow_guidance?.custom_instructions_excerpt??'')+chars(r.agent_guidance?.summary??'')+chars(r.agent_guidance?.settings.custom_instructions??'');
test('legacy/new defaults are derived without writes and validate exact settings types and Unicode bounds',()=>{
 const doc=workspace('guidance-defaults'),before=JSON.stringify(doc),g=effectiveGuidance(doc);assert.deepEqual(g.settings,guidanceDefaults);assert.equal(g.revision,0);assert.equal(g.schema_version,1);assert.ok(Object.values(g.sources).every(v=>v==='inherited'));assert.equal(JSON.stringify(doc),before);
 for(const bad of [{writing_strength_percent:-1},{writing_strength_percent:101},{writing_strength_percent:60.5},{writing_strength_percent:'60'},{record_snapshot_commit:'true'},{requirements_writing_style:'official-ste-compliant'},{custom_instructions:'😀'.repeat(8001)},{unexpected:true}])assert.equal(guidanceOverridesInput.safeParse(bad).success,false,JSON.stringify(bad).slice(0,100));
 assert.equal(guidanceOverridesInput.parse({custom_instructions:'😀'.repeat(8000)}).custom_instructions.length,16000);
});
test('399/400/401 code-point boundaries and every project response share one guidance budget',()=>{
 assert.ok(chars(initializationGuidance)<=400);assert.match(initializationGuidance,/list_projects.*project_id.*get_project/);
 for(const size of [399,400,401])for(const character of ['a','界','😀']){const b=boundedGuidance([],character.repeat(size));assert.equal(chars(b.excerpt),Math.min(size,400));assert.equal(b.truncated,size>400);}
 const doc=workspace('budget');apply(doc);
 for(const strength of [0,60,100])for(const custom of ['', 'x'.repeat(399),'y'.repeat(400),'😀'.repeat(401),'安全😀'.repeat(2000)])for(const name of toolMap.keys()){
  if(name==='list_projects')continue;
  doc.agentGuidance={revision:2,overrides:{writing_strength_percent:strength,custom_instructions:custom}};
  const r=projectGuidance(doc,name,{proposal_id:doc.proposals[0].id,baseline_id:doc.baselines[0].id},{proposal:doc.proposals[0],proposal_id:doc.proposals[0].id,implementation_commit:{commit_id:'a'.repeat(40)}});
  assert.ok(count(r)<=400,`${name}: ${count(r)}`);assert.equal(r.guidance_revision,2);assert.equal(doc.agentGuidance.overrides.custom_instructions,custom);
  const excerpt=name==='get_project'?r.agent_guidance.settings.custom_instructions:r.workflow_guidance.custom_instructions_excerpt;
  assert.equal(r.workflow_guidance.custom_instructions_truncated,chars(excerpt)<chars(custom));
  if(name==='get_project')assert.equal(r.agent_guidance.custom_instructions_truncated,chars(excerpt)<chars(custom));
 }
});
test('reminders retain exact context, review boundaries, style strength and disabled defaults',()=>{
 const doc=workspace('context'),p=doc.proposals[0];
 let r=projectGuidance(doc,'stage_proposal_changes',{proposal_id:p.id},{});assert.match(r.workflow_guidance.reminder,/60%/);assert.equal(r.workflow_guidance.context.proposal_id,p.id);
 r=projectGuidance(doc,'submit_proposal',{proposal_id:p.id},{});assert.match(r.workflow_guidance.reminder,/awaits human Apply/);assert.match(r.workflow_guidance.reminder,/no implementation snapshot/);
 apply(doc);const baseline=doc.proposals[0].appliedSnapshot;
 r=projectGuidance(doc,'get_proposal',{proposal_id:p.id},{proposal:doc.proposals[0]});assert.equal(r.workflow_guidance.context.baseline_id,baseline);assert.match(r.workflow_guidance.reminder,/first-included/);assert.match(r.workflow_guidance.reminder,/40\/64/);
 r=projectGuidance(doc,'get_snapshot',{baseline_id:'BL-001'},{});assert.equal(r.workflow_guidance.context.baseline_id,'BL-001');assert.match(r.workflow_guidance.reminder,/get_snapshot to verify/);
 doc.agentGuidance={revision:1,overrides:{writing_strength_percent:0,record_snapshot_commit:false}};
 r=projectGuidance(doc,'stage_proposal_changes',{proposal_id:p.id},{});assert.doesNotMatch(r.workflow_guidance.reminder,/STE|short active/);
 r=projectGuidance(doc,'get_snapshot',{baseline_id:'BL-001'},{});assert.doesNotMatch(r.workflow_guidance.reminder,/set_snapshot_implementation|Git SHA/);
 r=projectGuidance(doc,'set_snapshot_implementation',{baseline_id:'BL-001'},{implementation_commit:{commit_id:'b'.repeat(40)}});assert.match(r.workflow_guidance.reminder,/Reference saved/);assert.equal(r.workflow_guidance.context.baseline_id,'BL-001');
 delete doc.proposals[0].appliedSnapshot;delete doc.proposals[0].appliedVersion;r=projectGuidance(doc,'get_proposal',{proposal_id:p.id},{proposal:doc.proposals[0]});assert.match(r.workflow_guidance.reminder,/unknown/);
});
