import {acceptRequirements} from './fixtures/accepted-requirements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {toolMap} from '../lib/mcp/contracts.ts';
import {matchesRequirement} from '../lib/tags.ts';
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Tagging tests require a local disposable database.');
let cookie;
async function rest(body,status=200){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;}
async function call(name,args,code){const r=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',Cookie:cookie},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const b=await r.json();assert.equal(r.status,200);assert.equal(b.result.isError,!!code,JSON.stringify(b));const d=b.result.structuredContent;if(code)assert.equal(d.error.code,code);else toolMap.get(name).output.parse(d);return d;}

test('tagging persists across REST and MCP, filters pages, and preserves review boundaries',async t=>{
  cookie=(await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  let doc=await rest({action:'project',name:'Tagging API QA (local)',prefix:'TQ'});const project_id=doc.id;
  const accept=async({requirements})=>doc=await acceptRequirements(doc,requirements,rest);
  const read=async()=>doc=await (await fetch(origin+'/api/workspace?project='+project_id)).json();
  const mutate=async(action,payload={})=>doc=await rest({action,project:project_id,version:doc.version,...payload});
  const write=extra=>({project_id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),...extra});
  await mutate('section',{section:{title:'Core behavior',description:''}});await mutate('section',{section:{title:'Operations',description:''}});
  const input=(title,extra={})=>({section:doc.sections[0].id,title,description:'The system preserves the requested behavior.',criteria:['An observable acceptance criterion.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
  await accept({requirements:[input('Gateway authorization',{tags:[' MCP ','SECURITY','mcp']}),input('Remote catalog',{status:'Approved',tags:['mcp']}),input('Durable operation',{section:doc.sections[1].id,tags:['reliability']}),input('Unclassified behavior')]});
  assert.deepEqual(doc.requirements[0].tags,['mcp','security']);assert.deepEqual(doc.requirements[3].tags,[]);
  await mutate('baseline',{name:'Initial tagged snapshot'});const frozen=structuredClone(doc.baselines[0]);
  await t.test('exact Any/All/Untagged filters and tag text search agree with the UI',async()=>{
    const before=structuredClone(doc);
    for(const [filters,expected] of [[{tags:['mcp','security']},['TQ-001','TQ-002']],[{tags:['mcp','security'],tag_mode:'all'},['TQ-001']],[{tags:['sec']},[]],[{query:'SECUR'},['TQ-001']],[{untagged_only:true},['TQ-004']],[{tags:['mcp'],status:'Draft',section:doc.sections[0].id},['TQ-001']],[{tags:[]},['TQ-001','TQ-002','TQ-003','TQ-004']]]){
      const result=await call('list_requirements',{project_id,...filters});assert.deepEqual(result.items.map(r=>r.id),expected);assert.deepEqual(doc.requirements.filter(r=>matchesRequirement(r,filters)).map(r=>r.id),expected);
    }
    await call('list_requirements',{project_id,tags:['mcp'],untagged_only:true},'VALIDATION_ERROR');
    await call('list_requirements',{project_id,tags:['invalid!']},'VALIDATION_ERROR');
    await call('list_requirements',{project_id,tags:Array(21).fill('mcp')},'VALIDATION_ERROR');
    await call('list_requirements',{project_id,tags:['mcp'],tag_mode:'each'},'VALIDATION_ERROR');
    assert.deepEqual(await read(),before);
  });
  await t.test('cursor identity uses normalized filters and detects changed filters and revisions',async()=>{
    const page=await call('list_requirements',{project_id,tags:[' MCP ','mcp'],limit:1});assert.equal(page.items[0].id,'TQ-001');assert.ok(page.next_cursor);
    const next=await call('list_requirements',{project_id,tags:['mcp'],limit:1,cursor:page.next_cursor});assert.equal(next.items[0].id,'TQ-002');
    for(const filters of [{tags:['security']},{tags:['mcp'],tag_mode:'all'},{tags:[],untagged_only:true}])await call('list_requirements',{project_id,...filters,limit:1,cursor:page.next_cursor},'INVALID_CURSOR');
    await accept({requirements:[{...input('Unclassified behavior revised'),id:'TQ-004'}]});
    await call('list_requirements',{project_id,tags:['mcp'],limit:1,cursor:page.next_cursor},'RESTART_REQUIRED');
  });
  await t.test('REST omission preserves tags; normalized no-ops do not create revisions or history',async()=>{
    await mutate('proposal',{proposal:{title:'REST tag normalization checks'}});const proposal_id=doc.proposals[0].id;
    let r=doc.requirements[0],rev=r.revision;const history=doc.history.length,set=doc.requirementsVersion;
    await mutate('requirements',{proposal_id,requirements:[{...input(r.title),id:r.id,tags:['SECURITY',' MCP ','mcp']}]});assert.equal(doc.proposals[0].requirements[0].revision,rev);assert.equal(doc.history.length,history);assert.equal(doc.requirementsVersion,set);
    await mutate('requirements',{proposal_id,requirements:[{...input('Gateway authentication'),id:r.id}]});assert.deepEqual(doc.proposals[0].requirements[0].tags,['mcp','security']);assert.equal(doc.proposals[0].requirements[0].revision,rev+1);assert.equal(doc.requirements[0].revision,rev);
    await mutate('proposal_submit',{id:proposal_id});await mutate('proposal_review',{id:proposal_id,review:{decision:'apply'}});
    const before=structuredClone(doc);await rest({action:'requirements',project:project_id,version:doc.version,requirements:[input('Valid batch member',{tags:['valid']}),input('Invalid batch member',{tags:['not!valid']})]},400);assert.deepEqual(await read(),before);
  });
  let proposal_id;
  await t.test('MCP stages tag-only edits, preserves omitted tags, rolls back invalid batches and retries once',async()=>{
    proposal_id=(await call('create_proposal',write({title:'Tagging review fixture'}))).proposal_id;await read();
    const unchanged=structuredClone(doc.requirements),before=structuredClone(doc);
    await call('stage_proposal_changes',write({proposal_id,operations:[{op:'add',client_ref:'new',requirement:input('Valid staged addition',{tags:['new-tag']})},{op:'edit',requirement_id:'TQ-001',requirement:input('Gateway authentication',{tags:['bad!']})}]}),'VALIDATION_ERROR');assert.deepEqual(await read(),before);
    const args=write({proposal_id,operations:[{op:'edit',requirement_id:'TQ-001',requirement:input('Gateway authentication',{tags:['mcp','reliability']})}]});const result=await call('stage_proposal_changes',args);await read();
    const after=structuredClone(doc);assert.deepEqual(await call('stage_proposal_changes',args),result);assert.deepEqual(await read(),after);assert.deepEqual(doc.requirements,unchanged);
    let p=(await call('get_proposal',{project_id,proposal_id})).proposal;assert.deepEqual(p.changes[0].fields,['tags']);assert.deepEqual(p.requirements[0].tags,['mcp','reliability']);
    await call('stage_proposal_changes',write({proposal_id,operations:[{op:'edit',requirement_id:'TQ-001',requirement:input('Gateway authentication')},{op:'add',client_ref:'fresh',requirement:input('New staged item')}]}));await read();p=doc.proposals[0];assert.deepEqual(p.requirements[0].tags,['mcp','reliability']);assert.deepEqual(p.requirements.at(-1).tags,[]);
    await call('stage_proposal_changes',write({proposal_id,operations:[{op:'edit',requirement_id:'TQ-002',requirement:input('Remote catalog',{status:'Approved',tags:[]})}]}));await read();assert.deepEqual(doc.proposals[0].requirements[1].tags,[]);
    await call('submit_proposal',write({proposal_id}));await read();assert.deepEqual(doc.requirements,unchanged);
  });
  await t.test('apply advances set once, freezes exact tags, and leaves old evidence and snapshots intact',async()=>{
    const version=doc.requirementsVersion;await mutate('proposal_review',{id:proposal_id,review:{decision:'apply'}});assert.equal(doc.requirementsVersion,version+1);assert.deepEqual(doc.requirements[0].tags,['mcp','reliability']);assert.ok(doc.baselines.length>=2);assert.deepEqual(doc.baselines.find(b=>b.id===frozen.id),frozen);
    assert.deepEqual((await call('get_snapshot',{project_id,baseline_id:frozen.id})).snapshot,frozen);await rest({action:'proposal_review',project:project_id,version:doc.version,id:proposal_id,review:{decision:'apply'}},400);assert.equal((await read()).baselines[0].requirementsVersion,version+1);
    const other=await rest({action:'project',name:'Tag isolation QA (local)',prefix:'TI'});assert.equal((await call('list_requirements',{project_id:other.id,tags:['mcp']})).items.length,0);
  });
});
