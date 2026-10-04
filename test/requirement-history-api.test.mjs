import test from 'node:test';
import assert from 'node:assert/strict';
import {toolMap} from '../lib/mcp/contracts.ts';
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('History tests require a loopback database.');
async function rest(body,status=200){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
test('REST, browser history reader and MCP share durable provenance with atomic failures and retries',async t=>{
  const cookie=(await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  let doc=await rest({action:'project',name:'CP-003 History API QA (local)',prefix:'HQ'});
  const read=async()=>doc=await (await fetch(origin+'/api/workspace?project='+doc.id)).json();
  const mutate=async(action,data={})=>doc=await rest({action,project:doc.id,version:doc.version,...data});
  const history=async(id,query={},status=200)=>{const r=await fetch(origin+'/api/requirement-history?'+new URLSearchParams({project_id:doc.id,requirement_id:id,...query}));const h=await r.json();assert.equal(r.status,status,JSON.stringify(h));return h;};
  const call=async(name,args,code)=>{const response=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',Cookie:cookie},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const {result}=await response.json();assert.equal(result.isError,!!code,JSON.stringify(result));if(code)assert.equal(result.structuredContent.error.code,code);else toolMap.get(name).output.parse(result.structuredContent);return result.structuredContent;};
  await mutate('section',{section:{title:'Historical behavior',description:''}});
  const input=(extra={})=>({section:doc.sections[0].id,title:'History API requirement',description:'Capture exact history across every read interface.',criteria:['The event remains readable.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
  await mutate('requirements',{requirements:[input(),input({title:'Delete through proposal'})]});
  const id=doc.requirements[0].id,created=(await history(id)).lifecycle.created;
  await t.test('reads do not write and get_requirement exposes the same lifecycle',async()=>{
    const before=structuredClone(doc),h=await history(id),m=await call('get_requirement_history',{project_id:doc.id,requirement_id:id});assert.deepEqual(h,m);assert.deepEqual((await call('get_requirement',{project_id:doc.id,requirement_id:id})).lifecycle,h.lifecycle);assert.deepEqual(await read(),before);
    assert.equal((await history('HQ-999',{},404)).error.code,'NOT_FOUND');await call('get_requirement_history',{project_id:doc.id,requirement_id:id,limit:101},'VALIDATION_ERROR');
  });
  await t.test('forged metadata is ignored; stale and rejected batches leave no event',async()=>{
    await mutate('requirements',{requirements:[{...doc.requirements[0],title:'Legitimate direct update',createdAt:'1900-01-01T00:00:00Z',lifecycle:{created:'forged'},history:[{actor:'forged'}]}]});
    assert.deepEqual((await history(id)).lifecycle.created,created);const before=structuredClone(doc);
    await rest({action:'requirements',project:doc.id,version:doc.version-1,requirements:[input()]},409);
    await rest({action:'requirements',project:doc.id,version:doc.version,requirements:[input(),input({links:['HQ-999']})]},400);
    assert.deepEqual(await read(),before);
  });
  let addition;
  await t.test('MCP pending creation is idempotent and existing staging creates no committed history',async()=>{
    await mutate('proposal',{proposal:{title:'History acceptance batch'}});
    const args={project_id:doc.id,proposal_id:doc.proposals[0].id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),operations:[{op:'add',client_ref:'addition',requirement:input({title:'Pending addition'})},{op:'edit',requirement_id:id,requirement:input({title:'Accepted new title',status:'Approved'})},{op:'delete',requirement_id:'HQ-002'}]};
    const result=await call('stage_proposal_changes',args);addition=result.client_refs.addition;await read();const before=structuredClone(doc);assert.deepEqual(await call('stage_proposal_changes',args),result);assert.deepEqual(await read(),before);
    const pending=await history(addition);assert.equal(pending.items.length,1);assert.equal(pending.items[0].committed,false);assert.ok(pending.items[0].actor.id);assert.equal((await history(id)).items.length,2);
  });
  await t.test('applied provenance, frozen snapshots, deleted navigation and later direct revisions',async()=>{
    const pending=await history(addition),proposal=doc.proposals[0].id;
    await mutate('proposal_submit',{id:proposal});await mutate('proposal_review',{id:proposal,review:{decision:'apply',note:'Confirmed history changes'}});
    const accepted=await history(id),added=await history(addition),deleted=await history('HQ-002');
    assert.deepEqual(added.lifecycle.created,pending.lifecycle.created);assert.equal(added.lifecycle.first_approved.state,'not_recorded');assert.equal(deleted.presence,'deleted');assert.equal(accepted.items[0].snapshotId,doc.baselines[0].id);assert.equal(accepted.items[0].reviewNote,'Confirmed history changes');assert.equal(accepted.lifecycle.first_approved.revision,3);
    const frozen=JSON.stringify(doc.baselines),page=await history(id,{limit:'1'});assert.ok(page.next_cursor);
    const next=await history(id,{limit:'1',cursor:page.next_cursor});assert.notEqual(next.items[0].id,page.items[0].id);
    await mutate('requirements',{requirements:[{...doc.requirements[0],title:'Direct revision after acceptance'}]});
    const latest=await history(id);assert.equal(latest.lifecycle.last_change_accepted.revision,3);assert.equal(latest.lifecycle.last_changed.revision,4);assert.equal(JSON.stringify(doc.baselines),frozen);
    assert.equal((await history(id,{limit:'1',cursor:page.next_cursor},409)).error.code,'RESTART_REQUIRED');
    assert.deepEqual(await call('get_requirement_history',{project_id:doc.id,requirement_id:'HQ-002'}),await history('HQ-002'));
  });
  await t.test('overlapping requirement IDs across projects are isolated',async()=>{
    const original=doc,second=await rest({action:'project',name:'CP-003 isolated history (local)',prefix:'HQ'});
    doc=second;await mutate('section',{section:{title:'Other project',description:''}});await mutate('requirements',{requirements:[input({title:'Unrelated project identity'})]});
    const other=await history(id);assert.equal(other.items.length,1);assert.equal(other.title,'Unrelated project identity');assert.ok(other.items.every(e=>e.projectId===doc.id));doc=original;assert.equal((await history(id)).items.length,4);
  });
  // Stable UI fixture, created only in local storage. Open this project for browser QA.
  console.log('CP003_UI_PROJECT='+doc.id);
});
