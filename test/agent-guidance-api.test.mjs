import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {toolMap} from '../lib/mcp/contracts.ts';
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Use loopback QA storage.');
async function rest(body,status=200,path='/api/workspace',headers={}){const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});const text=await response.text();assert.equal(response.status,status,text);return response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):{error:text};}
const chars=s=>Array.from(s??'').length;
function bounded(r){assert.ok(chars(r.workflow_guidance?.reminder)+chars(r.workflow_guidance?.custom_instructions_excerpt)+chars(r.agent_guidance?.summary)+chars(r.agent_guidance?.settings.custom_instructions)<=400);}
test('independent MCP session observes guidance revisions, bounded excerpts and a real implementation commit workflow',async t=>{
 const cookie=(await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
 let doc=await rest({action:'project',name:'BL008 Guidance MCP QA',prefix:'AG'});
 const read=async()=>doc=await (await fetch(origin+'/api/workspace?project='+doc.id)).json();
 const mutate=async(action,data={})=>doc=await rest({action,project:doc.id,version:doc.version,...data});
 const args=extra=>({project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),...extra});
 const rpc=async(method,params,authenticated=true)=>{const r=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...(authenticated?{Cookie:cookie}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,data:await r.json()};};
 const call=async(name,input,code)=>{const {status,data}=await rpc('tools/call',{name,arguments:input});assert.equal(status,200);assert.equal(data.result.isError,!!code,JSON.stringify(data));const r=data.result.structuredContent;if(code)assert.equal(r.error.code,code);else{toolMap.get(name).output.parse(r);bounded(r);}return r;};
 const settings=async(overrides,status=200,extra={})=>{const result=await rest(args({overrides,...extra}),status,'/api/agent-guidance',{Cookie:cookie});if(status===200)doc=result;return result;};
 await t.test('generic discovery has no private guidance; defaults and reads make no writes',async()=>{
  const before=structuredClone(doc);const init=(await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Independent guidance client',version:'1'}},false)).data.result;
  assert.ok(chars(init.instructions)<=400);assert.match(init.instructions,/list_projects.*get_project/);const list=(await rpc('tools/list',{},false)).data.result.tools;assert.equal(list.length,18);assert.ok(!list.some(x=>/apply|settings/.test(x.name)));assert.match(list.find(x=>x.name==='get_project').description,/guidance/);
  const project=await call('get_project',{project_id:doc.id});assert.equal(project.agent_guidance.settings.writing_strength_percent,60);assert.equal(project.agent_guidance.settings.record_snapshot_commit,true);assert.equal(project.guidance_revision,0);assert.deepEqual(await read(),before);
  assert.equal((await rpc('tools/call',{name:'get_project',arguments:{project_id:doc.id}},false)).status,401);
 });
 await t.test('field-specific validation, denied origin, meaningful/no-op saves, stale writes and isolation',async()=>{
  const before=structuredClone(doc);for(const overrides of [{writing_strength_percent:'60'},{writing_strength_percent:101},{writing_strength_percent:0.5},{record_snapshot_commit:1},{requirements_writing_style:'unsupported'},{custom_instructions:'界'.repeat(8001)},{extra:true}]){const e=await settings(overrides,400);assert.equal(e.error.code,'VALIDATION_ERROR');assert.ok(e.error.fields.length);}
  await rest(args({overrides:{writing_strength_percent:0}}),403,'/api/agent-guidance',{Origin:'https://foreign.example'});assert.deepEqual(await read(),before);
  const overrides={writing_strength_percent:100,record_snapshot_commit:false,custom_instructions:'Private project instructions 😀 '.repeat(150)};await settings(overrides);assert.equal(doc.agentGuidance.revision,1);assert.equal(doc.version,before.version+1);const saved=structuredClone(doc);await settings(overrides);assert.deepEqual(doc,saved);await settings({},409,{expected_workspace_version:before.version});assert.deepEqual(await read(),saved);
  const project=await call('get_project',{project_id:doc.id});assert.equal(project.guidance_revision,1);assert.equal(project.agent_guidance.settings.writing_strength_percent,100);assert.equal(project.agent_guidance.sources.writing_strength_percent,'project_override');assert.equal(project.agent_guidance.custom_instructions_truncated,true);assert.ok(overrides.custom_instructions.startsWith(project.agent_guidance.settings.custom_instructions));
  assert.ok(!JSON.stringify((await rpc('tools/list',{},false)).data).includes('Private project instructions'));assert.ok(!JSON.stringify((await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'Same connection',version:'1'}},false)).data).includes('Private project instructions'));
  const other=await rest({action:'project',name:'Guidance isolation',prefix:'AG'});assert.equal((await call('get_project',{project_id:other.id})).guidance_revision,0);
  const imported=structuredClone(doc);delete imported.agentGuidance;await mutate('import',{workspace:imported});assert.deepEqual(doc.agentGuidance,saved.agentGuidance);await mutate('section',{section:{title:'Guided behavior',description:''}});assert.deepEqual(doc.agentGuidance,saved.agentGuidance);
 });
 let proposal;
 await t.test('saved settings affect writes and reads in an existing connection; 0 disables style and false removes commit action',async()=>{
  await settings({writing_strength_percent:0,record_snapshot_commit:false,custom_instructions:'Use the exact requested project.'});
  const createArgs=args({title:'Implement guided fixture'});const created=await call('create_proposal',createArgs);proposal=created.proposal_id;assert.doesNotMatch(created.workflow_guidance.reminder,/STE-inspired/);await read();
  await settings({writing_strength_percent:60,record_snapshot_commit:true,custom_instructions:'Preserve the requested target.'});
  const retried=await call('create_proposal',createArgs);assert.equal(retried.guidance_revision,3);assert.equal(retried.proposal_id,created.proposal_id);assert.equal(retried.workspace_version,created.workspace_version);
  const input={section:doc.sections[0].id,title:'Add a sum helper',description:'The implementation shall add two numbers.',criteria:['sum(2, 3) returns 5.'],priority:'High',status:'Draft'};
  const staged=await call('stage_proposal_changes',args({proposal_id:proposal,operations:[{op:'add',client_ref:'sum',requirement:input}]}));assert.match(staged.workflow_guidance.reminder,/60%/);assert.equal(staged.guidance_revision,3);await read();
  const submitted=await call('submit_proposal',args({proposal_id:proposal}));assert.match(submitted.workflow_guidance.reminder,/awaits human Apply/);assert.match(submitted.workflow_guidance.reminder,/no implementation snapshot/);await read();assert.equal(doc.requirements.length,0);
  await mutate('proposal_review',{id:proposal,review:{decision:'apply'}});
  const applied=await call('get_proposal',{project_id:doc.id,proposal_id:proposal});assert.equal(applied.workflow_guidance.context.baseline_id,doc.proposals[0].appliedSnapshot);assert.match(applied.workflow_guidance.reminder,/set_snapshot_implementation/);
 });
 await t.test('real multi-commit implementation records only its first-included snapshot and verifies exact readback',async()=>{
  const baseline=doc.proposals[0].appliedSnapshot,frozen=structuredClone(doc.baselines),requirements=structuredClone(doc.requirements),dir=await mkdtemp(join(tmpdir(),'guidance-implementation-'));
  try{
   const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();git('init','-q');git('config','user.name','Local QA');git('config','user.email','qa@example.test');await writeFile(join(dir,'sum.mjs'),'export const sum = (a, b) => a + b;\n');git('add','sum.mjs');git('commit','-qm','Implement the requested sum helper');const first=git('rev-parse','HEAD');await writeFile(join(dir,'verify.mjs'),"import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5);\n");execFileSync(process.execPath,['verify.mjs'],{cwd:dir});git('add','verify.mjs');git('commit','-qm','Verify the requested behavior');const commit=git('rev-parse','HEAD');assert.match(commit,/^[a-f0-9]{40}$/);assert.notEqual(first,commit);assert.match(git('show',commit+':sum.mjs'),/a \+ b/);
   await mutate('baseline',{name:'Later unrelated snapshot'});const later=doc.baselines[0].id;let target=await call('get_snapshot',{project_id:doc.id,baseline_id:baseline});assert.equal(target.associations.implementation_commit,null);assert.equal(target.workflow_guidance.context.baseline_id,baseline);
   const write=args({baseline_id:baseline,implementation_commit:{commit_id:commit}});const recorded=await call('set_snapshot_implementation',write);assert.match(recorded.workflow_guidance.reminder,/Reference saved/);assert.equal(recorded.baseline_id,baseline);await read();assert.deepEqual(await call('set_snapshot_implementation',write),recorded);target=await call('get_snapshot',{project_id:doc.id,baseline_id:baseline});assert.deepEqual(target.associations.implementation_commit,{commit_id:commit});assert.equal((await call('get_snapshot',{project_id:doc.id,baseline_id:later})).associations.implementation_commit,null);
   const before=structuredClone(doc);await call('set_snapshot_implementation',args({baseline_id:baseline,implementation_commit:{commit_id:'short'}}),'VALIDATION_ERROR');await call('set_snapshot_implementation',{...args({baseline_id:baseline,implementation_commit:null}),expected_workspace_version:doc.version-1},'CONFLICT');assert.deepEqual(await read(),before);assert.deepEqual(doc.requirements,requirements);assert.deepEqual(doc.baselines.slice(1),frozen);assert.equal(doc.snapshotImplementations[baseline].history.length,1);
   await settings({record_snapshot_commit:false,writing_strength_percent:100});target=await call('get_snapshot',{project_id:doc.id,baseline_id:baseline});assert.doesNotMatch(target.workflow_guidance.reminder,/set_snapshot_implementation/);assert.equal(target.associations.implementation_commit.commit_id,commit);
   await settings({});const reset=await call('get_project',{project_id:doc.id});assert.equal(reset.agent_guidance.settings.writing_strength_percent,60);assert.equal(reset.agent_guidance.settings.record_snapshot_commit,true);assert.ok(Object.values(reset.agent_guidance.sources).every(x=>x==='inherited'));
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
