import {acceptRequirements} from './fixtures/accepted-requirements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {toolMap} from '../lib/mcp/contracts.ts';
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Implementation tests require a loopback database.');
async function rest(body,status=200){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
test('snapshot metadata agrees across application API, MCP and saved workspace',async t=>{
  const cookie=(await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  let doc=await rest({action:'project',name:'CP-004 Snapshot Commit QA (local)',prefix:'CQ'});
  const accept=async({requirements})=>doc=await acceptRequirements(doc,requirements,rest);
  const read=async()=>doc=await (await fetch(origin+'/api/workspace?project='+doc.id)).json();
  const mutate=async(action,data={})=>doc=await rest({action,project:doc.id,version:doc.version,...data});
  const call=async(name,args,code)=>{const response=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',Cookie:cookie},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const {result}=await response.json();assert.equal(result.isError,!!code,JSON.stringify(result));if(code)assert.equal(result.structuredContent.error.code,code);else toolMap.get(name).output.parse(result.structuredContent);return result.structuredContent;};
  const api=async(args,status=200,headers={})=>{const response=await fetch(origin+'/api/snapshot-implementation',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(args)});const text=await response.text();assert.equal(response.status,status,text);return response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):{error:{message:text}};};
  const get=async(id,query={},status=200)=>{const response=await fetch(origin+'/api/snapshot-implementation?'+new URLSearchParams({project_id:doc.id,baseline_id:id,...query}),{headers:{Cookie:cookie}});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;};
  const args=(commit,baseline_id='BL-001')=>({project_id:doc.id,baseline_id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),implementation_commit:commit});
  const input=extra=>({section:doc.sections[0].id,title:'Snapshot API requirement',description:'Preserve exact frozen implementation context.',criteria:['The saved context remains readable.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
  await mutate('section',{section:{title:'Snapshot behavior',description:''}});await accept({requirements:[input(),input({title:'Deleted by proposal'})]});await mutate('repository',{repository:{name:'Test implementation',url:'https://example.com/project',branch:'main'}});
  await mutate('proposal',{proposal:{title:'Accepted snapshot changes'}});const proposal=doc.proposals[0].id;
  await mutate('proposal_requirement',{id:proposal,requirement:input({id:'CQ-001',title:'Changed requirement'})});await mutate('proposal_delete',{id:proposal,requirementId:'CQ-002'});await mutate('proposal_requirement',{id:proposal,requirement:input({title:'Added requirement'})});
  await t.test('pending then applied inclusion exposes exact first snapshot and reverse links',async()=>{
    assert.equal((await call('get_proposal',{project_id:doc.id,proposal_id:proposal})).proposal.first_included.state,'not_yet_included');await mutate('proposal_submit',{id:proposal});await mutate('proposal_review',{id:proposal,review:{decision:'apply',note:'Verified test batch'}});
    const p=(await call('get_proposal',{project_id:doc.id,proposal_id:proposal})).proposal;assert.equal(p.first_included.snapshot.id,'BL-002');assert.equal((await get('BL-002')).associations.first_included_proposals[0].id,proposal);assert.deepEqual((await get('BL-002')).snapshot,doc.baselines[0]);
  });
  const protectedContent=()=>JSON.stringify({baselines:doc.baselines,requirements:doc.requirements,sections:doc.sections,proposals:doc.proposals,evidence:doc.evidence,requirementHistory:doc.requirementHistory,set:doc.requirementsVersion});const original=protectedContent();
  await t.test('API writes, MCP retries and reads share durable metadata without changing frozen context',async()=>{
    const request=args({commit_id:' AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ',repository_id:doc.repositories[0].id,commit_url:'https://example.com/commit/a'},'BL-002');const result=await api(request);toolMap.get('set_snapshot_implementation').output.parse(result);await read();assert.equal(result.workspace_version,doc.version);assert.equal(result.implementation_commit.commit_id,'a'.repeat(40));assert.equal(result.implementation_actor.id,'local_seedy');assert.deepEqual(await call('set_snapshot_implementation',request),result);
    assert.deepEqual((await get('BL-002')).associations.implementation_commit,result.implementation_commit);assert.deepEqual((await call('get_proposal',{project_id:doc.id,proposal_id:proposal})).proposal.first_included.implementation_commit,result.implementation_commit);assert.equal(protectedContent(),original);
    const before=structuredClone(doc);const noop=await api(args({...request.implementation_commit,commit_id:'a'.repeat(40)},'BL-002'));assert.equal(noop.workspace_version,doc.version);await read();assert.deepEqual(doc,before);
    const history=await get('BL-002',{history:'1'});assert.deepEqual(history,await call('get_snapshot_implementation_history',{project_id:doc.id,baseline_id:'BL-002'}));assert.equal(history.items.length,1);
  });
  await t.test('validation, absent required fields, origin rejection and stale saves leave no partial state',async()=>{
    const before=structuredClone(doc),base=args(null);delete base.implementation_commit;assert.equal((await api(base,400)).error.code,'VALIDATION_ERROR');
    for(const value of [{commit_id:'short'},{commit_id:'a'.repeat(40),commit_url:'not a url'},{commit_id:'a'.repeat(40),repository_id:'not-in-this-project'},{commit_id:'a'.repeat(40),commit_url:'http://example.com'}])assert.equal((await api(args(value),400)).error.code,'VALIDATION_ERROR');
    assert.equal((await api({...args(null),expected_workspace_version:doc.version-1},409)).error.code,'CONFLICT');assert.equal((await api(args(null,'BL-999'),404)).error.code,'NOT_FOUND');await api(args(null),403,{Origin:'https://foreign.example'});await call('set_snapshot_implementation',base,'VALIDATION_ERROR');assert.deepEqual(await read(),before);
  });
  await t.test('replacing clears omitted fields, history pages are bounded and clearing is explicit',async()=>{
    await call('set_snapshot_implementation',args({commit_id:'b'.repeat(64)},'BL-002'));await read();assert.deepEqual((await get('BL-002')).associations.implementation_commit,{commit_id:'b'.repeat(64)});
    const page=await get('BL-002',{history:'1',limit:'1'});assert.ok(page.next_cursor);assert.equal((await get('BL-002',{history:'1',limit:'1',cursor:page.next_cursor})).items.length,1);assert.equal((await get('BL-001',{history:'1',limit:'1',cursor:page.next_cursor},400)).error.code,'INVALID_CURSOR');
    await api(args(null,'BL-002'));await read();assert.equal((await get('BL-002')).associations.implementation_commit,null);assert.equal((await get('BL-002',{history:'1',limit:'1',cursor:page.next_cursor},409)).error.code,'RESTART_REQUIRED');assert.equal(protectedContent(),original);
  });
  await t.test('later commits and unrelated saves do not retarget accepted proposals or erase metadata',async()=>{
    await mutate('baseline',{name:'Later snapshot'});await api(args({commit_id:'c'.repeat(40)},'BL-003'));await read();assert.equal((await call('get_proposal',{project_id:doc.id,proposal_id:proposal})).proposal.first_included.implementation_commit,null);
    await api(args({commit_id:'c'.repeat(40),repository_id:doc.repositories[0].id},'BL-002'));await read();const metadata=structuredClone(doc.snapshotImplementations);await mutate('repository_remove',{id:doc.repositories[0].id});await accept({requirements:[input({id:'CQ-001',title:'Later direct revision'})]});assert.deepEqual(doc.snapshotImplementations,metadata);
    const imported=structuredClone(doc);delete imported.snapshotImplementations;await mutate('import',{workspace:imported});assert.deepEqual(doc.snapshotImplementations,metadata);assert.equal((await call('get_proposal',{project_id:doc.id,proposal_id:proposal})).proposal.first_included.snapshot.id,'BL-002');
  });
  await t.test('overlapping project snapshot/proposal IDs are isolated and foreign repositories rejected',async()=>{
    const originalDoc=doc;doc=await rest({action:'project',name:'CP-004 Isolated QA (local)',prefix:'CQ'});await mutate('baseline',{name:'Other project snapshot'});assert.equal((await get('BL-001')).associations.implementation_commit,null);await api(args({commit_id:'d'.repeat(40)}));await read();assert.equal((await get('BL-001')).associations.implementation_commit.commit_id,'d'.repeat(40));doc=originalDoc;assert.equal((await get('BL-001')).associations.implementation_commit,null);
    await mutate('proposal',{proposal:{title:'Rejected proposal is not included'}});const rejected=doc.proposals[0].id;await mutate('proposal_requirement',{id:rejected,requirement:input({title:'Rejected addition'})});await mutate('proposal_submit',{id:rejected});await mutate('proposal_review',{id:rejected,review:{decision:'reject'}});assert.equal((await call('get_proposal',{project_id:doc.id,proposal_id:rejected})).proposal.first_included.state,'not_yet_included');
  });
  console.log('CP004_UI_PROJECT='+doc.id);
});
