import test from 'node:test';
import assert from 'node:assert/strict';
import {toolMap} from '../lib/mcp/contracts.ts';

const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('MCP integration tests require a local disposable database.');
let cookie;
async function rpc(method,params={},options={}){
  const r=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...(options.auth===false?{}:{Cookie:cookie??''}),...options.headers},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const text=await r.text();let body;try{body=JSON.parse(text);}catch{body={message:text};}
  return {status:r.status,body};
}
async function call(name,args={},code){
  const {status,body}=await rpc('tools/call',{name,arguments:args,_meta:{'io.modelcontextprotocol/clientInfo':{name:'Wonderworks integration QA',version:'1.0'}}});
  assert.equal(status,200,JSON.stringify(body));
  if(code){assert.equal(body.result.isError,true);assert.equal(body.result.structuredContent.error.code,code);return body.result.structuredContent;}
  assert.equal(body.result.isError,false,JSON.stringify(body));
  const data=body.result.structuredContent;
  assert.deepEqual(JSON.parse(body.result.content[0].text),data);
  toolMap.get(name).output.parse(data);
  return data;
}
async function rest(body,expected=200){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;}

test('MCP transport, authentication boundary, and contract discovery',async t=>{
  const login=await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'});
  cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  for(const version of ['2025-03-26','2025-06-18','2025-11-25']){
    const init=await rpc('initialize',{protocolVersion:version,capabilities:{},clientInfo:{name:'Integration QA',version:'1.0'}},{auth:false,headers:{'MCP-Protocol-Version':version}});
    assert.equal(init.status,200);assert.equal(init.body.result.protocolVersion,version);
  }
  const catalog=await rpc('tools/list',{}, {auth:false});assert.equal(catalog.body.result.tools.length,16);
  assert.ok(catalog.body.result.tools.every(t=>t.inputSchema.additionalProperties===false&&t.outputSchema.type==='object'));
  assert.ok(!JSON.stringify(catalog).includes('Asteroids'));
  assert.equal((await rpc('tools/call',{name:'list_projects',arguments:{}},{auth:false})).status,401);
  assert.equal((await rpc('tools/call',{name:'list_projects',arguments:{}},{auth:false,headers:{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'forged@example.com'}})).status,401);
  assert.equal((await rpc('tools/call',{name:'list_projects',arguments:{}},{headers:{'OAI-Sites-Authorization':'Bearer not-user-auth'}})).status,403);
  assert.equal((await rpc('tools/list',{}, {headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await rpc('tools/list',{}, {headers:{'MCP-Protocol-Version':'2099-01-01'}})).status,400);
  assert.equal((await rpc('not/a/method')).body.error.code,-32601);
  assert.equal((await rpc('tools/call',{name:'apply_proposal',arguments:{}})).body.error.code,-32602);
  const notification=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});assert.equal(notification.status,202);assert.equal(await notification.text(),'');
  assert.equal((await fetch(origin+'/mcp')).status,405);
  const malformed=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:'{'});assert.equal((await malformed.json()).error.code,-32700);
  const oversize=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({padding:'é'.repeat(125000)})});assert.equal(oversize.status,413);
  await call('get_project',{},'VALIDATION_ERROR');await call('get_project',{project_id:'missing'},'NOT_FOUND');
  await call('list_projects',{limit:101},'VALIDATION_ERROR');await call('list_projects',{actorId:'forged'},'VALIDATION_ERROR');
});

test('MCP proposal, read, concurrency, evidence, and UI API workflow',async t=>{
  let doc=await rest({action:'project',name:'MCP QA (local)',prefix:'MQ'});
  const project_id=doc.id;
  async function mutate(action,payload={}){doc=await rest({project:project_id,version:doc.version,action,...payload});return doc;}
  async function read(){doc=await (await fetch(origin+'/api/workspace?project='+project_id)).json();return doc;}
  const write=(extra={})=>({project_id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),...extra});
  await mutate('section',{section:{title:'MCP behavior',description:'Local integration verification'}});
  const input=(title,links=[])=>({section:doc.sections[0].id,title,description:'The system shall preserve the proposed behavior.',criteria:['An observable criterion.'],priority:'High',status:'Draft',parameters:{enabled:true},links});
  await mutate('requirements',{requirements:[input('Unrelated current requirement'),input('Edit this requirement'),input('Delete this requirement')]});
  await mutate('baseline',{name:'Original exact snapshot'});
  const original=structuredClone(doc),frozen=structuredClone(doc.baselines[0]);
  const createArgs=write({title:'MCP staged changes',description:'Testing atomic staged changes.'});
  const created=await call('create_proposal',createArgs),proposal_id=created.proposal_id;await read();
  await t.test('retry keys return original results before stale version checks',async()=>{
    assert.deepEqual(await call('create_proposal',createArgs),created);
    const version=doc.version;await read();assert.equal(doc.version,version);assert.equal(doc.proposals.length,1);
    await call('create_proposal',{...createArgs,title:'Different operation'},'IDEMPOTENCY_KEY_REUSED');
    const conflict=await call('create_proposal',{...createArgs,idempotency_key:crypto.randomUUID()},'CONFLICT');assert.equal(conflict.error.current_workspace_version,version);
  });
  await t.test('invalid batches roll back IDs, history and staged content',async()=>{
    const before=structuredClone(doc);
    await call('stage_proposal_changes',write({proposal_id,operations:[{op:'add',client_ref:'bad',requirement:input('Invalid dependency',['MQ-999'])}]}),'VALIDATION_ERROR');
    assert.deepEqual(await read(),before);
    await call('stage_proposal_changes',write({proposal_id,operations:[{op:'add',client_ref:'a',requirement:input('Cycle A',['$b'])},{op:'add',client_ref:'b',requirement:input('Cycle B',['$a'])}]}),'VALIDATION_ERROR');
    assert.deepEqual(await read(),before);
  });
  let refs;
  await t.test('one batch supports forward references, edits, and deletions',async()=>{
    const result=await call('stage_proposal_changes',write({proposal_id,operations:[
      {op:'add',client_ref:'dependent',requirement:input('Added dependent',['$foundation'])},
      {op:'add',client_ref:'foundation',requirement:input('Added foundation')},
      {op:'edit',requirement_id:original.requirements[1].id,requirement:input('Edited via MCP')},
      {op:'delete',requirement_id:original.requirements[2].id}
    ]}));refs=result.client_refs;await read();
    assert.deepEqual(doc.requirements,original.requirements);assert.equal(doc.requirementsVersion,original.requirementsVersion);assert.deepEqual(doc.baselines,original.baselines);
    const audit=doc.history[0];assert.equal(audit.mcp.tool,'stage_proposal_changes');assert.equal(audit.mcp.actorId,'local_seedy');assert.equal(audit.mcp.clientName,'Wonderworks integration QA');
    assert.equal(doc.history.length,original.history.length+2);
    const p=(await call('get_proposal',{project_id,proposal_id})).proposal;
    assert.equal(p.changes.length,4);assert.equal(p.requirements.find(r=>r.id===refs.dependent).links[0],refs.foundation);
    assert.equal(p.requirements.find(r=>r.id===original.requirements[1].id).revision,2);
  });
  await t.test('reads and bounded pages return exact context without saving',async()=>{
    const before=structuredClone(doc);
    assert.equal((await call('get_project',{project_id})).sections[0].id,doc.sections[0].id);
    const first=await call('list_requirements',{project_id,limit:1});assert.equal(first.items.length,1);assert.ok(first.next_cursor);
    const second=await call('list_requirements',{project_id,limit:1,cursor:first.next_cursor});assert.notEqual(second.items[0].id,first.items[0].id);
    await call('list_requirements',{project_id,limit:1,cursor:first.next_cursor,query:'other'},'INVALID_CURSOR');
    await call('list_requirements',{project_id,cursor:btoa('null')},'INVALID_CURSOR');
    assert.equal((await call('list_requirements',{project_id,query:'OBSERVABLE',section:doc.sections[0].id,status:'Draft'})).items.length,3);
    assert.deepEqual((await call('get_requirement',{project_id,requirement_id:doc.requirements[0].id})).requirement,doc.requirements[0]);
    assert.deepEqual((await call('get_snapshot',{project_id,baseline_id:frozen.id})).snapshot,frozen);
    await call('list_snapshots',{project_id});await call('list_proposals',{project_id});await call('list_evidence',{project_id});await call('get_proposal',{project_id,proposal_id:'CP-999'},'NOT_FOUND');
    assert.deepEqual(await read(),before);
    await call('update_proposal',write({proposal_id,title:'Updated proposal title',description:'Updated reason for review.'}));await read();
    await call('list_requirements',{project_id,limit:1,cursor:first.next_cursor},'RESTART_REQUIRED');
  });
  await t.test('stale proposal and overlapping rebase require explicit resolution',async()=>{
    await call('submit_proposal',write({proposal_id}));await read();assert.equal(doc.proposals[0].status,'Proposed');
    await call('stage_proposal_changes',write({proposal_id,operations:[{op:'delete',requirement_id:refs.foundation}]}),'VALIDATION_ERROR');
    await mutate('requirements',{requirements:[{...doc.requirements[0],title:'Unrelated latest edit'},{...doc.requirements[1],title:'Overlapping latest edit'}]});
    const p=(await call('get_proposal',{project_id,proposal_id})).proposal;assert.equal(p.stale,true);assert.equal(p.conflicts.length,1);assert.equal(p.conflicts[0].latest.title,'Overlapping latest edit');
    await call('submit_proposal',write({proposal_id}),'STALE_PROPOSAL');
    await call('rebase_proposal',write({proposal_id,resolutions:{}}),'REBASE_CONFLICT');
    await call('rebase_proposal',write({proposal_id,resolutions:{[original.requirements[1].id]:'proposed'}}));await read();
    assert.equal(doc.proposals[0].status,'Draft');assert.equal(doc.proposals[0].requirements[0].title,'Unrelated latest edit');assert.equal(doc.proposals[0].requirements[1].title,'Edited via MCP');
    await call('submit_proposal',write({proposal_id}));await read();
  });
  await t.test('existing review application creates exactly one version and snapshot',async()=>{
    const version=doc.requirementsVersion,count=doc.baselines.length;
    await mutate('proposal_review',{id:proposal_id,review:{decision:'apply',note:'Local QA reviewer confirms staged batch.'}});
    assert.equal(doc.requirementsVersion,version+1);assert.equal(doc.baselines.length,count+1);assert.deepEqual(doc.baselines[0].requirements,doc.requirements);assert.deepEqual(doc.baselines.find(b=>b.id===frozen.id),frozen);
    assert.ok(!doc.requirements.some(r=>r.id===original.requirements[2].id));
  });
  await t.test('baseline-specific evidence preserves failure and replays once',async()=>{
    const before=structuredClone(doc);
    const evidence={baseline:frozen.id,artifactUrl:'https://example.com/qa',summary:'Original snapshot mixed verification results.',checks:[{id:original.requirements[2].id,title:'Deleted current requirement',passed:false,detail:'The tested baseline still contains it.'}]};
    const args=write({evidence}),result=await call('record_evidence',args);await read();assert.deepEqual(await call('record_evidence',args),result);
    assert.equal(doc.evidence[0].checks[0].passed,false);assert.deepEqual(doc.requirements,before.requirements);assert.deepEqual(doc.baselines,before.baselines);assert.equal(doc.requirementsVersion,before.requirementsVersion);
    assert.equal((await call('list_evidence',{project_id,baseline_id:frozen.id})).items.length,1);
    const saved=structuredClone(doc);
    await call('record_evidence',write({evidence:{...evidence,checks:[{...evidence.checks[0],id:'MQ-999'}]}}),'VALIDATION_ERROR');assert.deepEqual(await read(),saved);
  });
  await t.test('competing new writes cannot overwrite each other',async()=>{
    const args=write({title:'Concurrent proposal',description:''});
    const outcomes=await Promise.all([rpc('tools/call',{name:'create_proposal',arguments:args}),rpc('tools/call',{name:'create_proposal',arguments:{...args,idempotency_key:crypto.randomUUID()}})]);
    assert.equal(outcomes.filter(x=>!x.body.result.isError).length,1);assert.equal(outcomes.find(x=>x.body.result.isError).body.result.structuredContent.error.code,'CONFLICT');await read();
  });
  console.log('LOCAL_MCP_QA_PROJECT='+project_id);
});
