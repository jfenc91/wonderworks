import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTags,tagsOf,matchesRequirement,tagInventory} from '../lib/tags.ts';
import {upsert,exportSpecification,reconcileWorkspace} from '../lib/requirements.ts';
import {createProposal,editProposalRequirement,requirementChanges,submitProposal,reviewProposal,rebaseProposal,proposalConflicts,snapshot,setContent} from '../lib/workflow.ts';
import {callTool} from '../lib/mcp/service.ts';
import {toolMap} from '../lib/mcp/contracts.ts';
const input=(extra={})=>({section:'section',title:'Sample requirement',description:'The system shall preserve user intent.',criteria:['The result is observable.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
const legacy=()=>({id:'tags-test',prefix:'TG',name:'Tag compatibility',version:4,requirementsVersion:1,sections:[{id:'section',title:'Behavior',description:''}],requirements:[{...input(),id:'TG-001',revision:1}],baselines:[],evidence:[],history:[],proposals:[],repositories:[]});

test('tags normalize case/whitespace, bound raw inputs, and reject invalid values',()=>{
  assert.deepEqual(normalizeTags([' MCP ','security','Reliability','Access\tControl','mcp']),['access-control','mcp','reliability','security']);
  assert.deepEqual(normalizeTags([]),[]);
  assert.deepEqual(normalizeTags([' '.repeat(60)+'a'.repeat(40)]),['a'.repeat(40)]);
  assert.equal(normalizeTags(Array.from({length:20},(_,i)=>'tag-'+i)).length,20);
  for(const invalid of [null,{},'mcp',[1],[''],['  '],['a--b'],['-a'],['a-'],['café'],['ＭＣＰ'],['a_b'],['security!'],['a'.repeat(41)],[' '.repeat(61)+'a'.repeat(40)],Array(21).fill('mcp')]) assert.throws(()=>normalizeTags(invalid));
});

test('direct saves retain omitted tags, clear explicitly, and ignore equivalent sets',()=>{
  const doc=legacy();
  upsert(doc,{...input(),id:'TG-001',tags:[' Security ','MCP','mcp']});
  assert.deepEqual(doc.requirements[0].tags,['mcp','security']);assert.equal(doc.requirements[0].revision,2);
  const before=structuredClone(doc);
  upsert(doc,{...input(),id:'TG-001',tags:['SECURITY','mcp','mcp']});
  assert.deepEqual(doc,before);
  upsert(doc,{...input({title:'Updated title'}),id:'TG-001'});
  assert.deepEqual(doc.requirements[0].tags,['mcp','security']);assert.equal(doc.requirements[0].revision,3);
  upsert(doc,{...input({title:'Updated title'}),id:'TG-001',tags:[]});
  assert.deepEqual(doc.requirements[0].tags,[]);assert.equal(doc.requirements[0].revision,4);
  const empty=legacy(),plain=structuredClone(empty);upsert(empty,{...input(),id:'TG-001',tags:[]});
  assert.deepEqual(empty,plain);assert.equal(setContent(empty),setContent({...empty,requirements:empty.requirements.map(r=>({...r,tags:[]}))}));
  assert.deepEqual(upsert(empty,input({title:'New requirement'})).tags,[]);
});

test('tag-only proposals show diffs, isolate drafts, apply once and freeze tags',()=>{
  const doc=legacy();const old={id:'BL-001',name:'Legacy baseline',date:new Date().toISOString(),requirements:structuredClone(doc.requirements),sections:structuredClone(doc.sections)};
  doc.baselines.push(old);doc.evidence.push({id:'evidence',date:old.date,baseline:old.id,artifactUrl:'https://example.com/test',summary:'Legacy verification result.',checks:[{id:'TG-001',title:'Old check',passed:true,detail:'Historical evidence.'}]});
  const historic=JSON.stringify({baselines:doc.baselines,evidence:doc.evidence}),current=structuredClone(doc.requirements),p=createProposal(doc,{title:'Assign aspect tags'});
  editProposalRequirement(doc,p.id,{...input(),id:'TG-001',tags:['mcp']});
  assert.deepEqual(requirementChanges(p.baseRequirements,p.requirements).map(c=>c.fields),[['tags']]);assert.equal(p.requirements[0].revision,2);
  const staged=structuredClone(p);editProposalRequirement(doc,p.id,{...input(),id:'TG-001',tags:[' MCP ','mcp']});assert.deepEqual(p,staged);
  editProposalRequirement(doc,p.id,{...input({title:'Staged title'}),id:'TG-001'});assert.deepEqual(p.requirements[0].tags,['mcp']);
  editProposalRequirement(doc,p.id,{...input(),id:'TG-001',tags:['mcp']});
  submitProposal(doc,p.id);assert.deepEqual(doc.requirements,current);assert.equal(doc.requirementsVersion,1);assert.equal(JSON.stringify({baselines:doc.baselines,evidence:doc.evidence}),historic);
  reviewProposal(doc,p.id,{decision:'apply'});assert.equal(doc.requirementsVersion,2);assert.equal(doc.requirements[0].revision,2);assert.deepEqual(doc.baselines[0].requirements[0].tags,['mcp']);
  assert.throws(()=>reviewProposal(doc,p.id,{decision:'apply'}));assert.equal(doc.baselines.length,2);
  assert.equal(JSON.stringify({baselines:doc.baselines.slice(1),evidence:doc.evidence}),historic);
  assert.equal(old.requirements[0].revision,1);assert.ok(!Object.hasOwn(old.requirements[0],'tags'));
  assert.match(exportSpecification(doc),/Tags: mcp/);
  upsert(doc,{...input(),id:'TG-001',tags:['reliability']});assert.deepEqual(doc.baselines[0].requirements[0].tags,['mcp']);
});

test('tag rebase requires conflict resolution and keeps unrelated changes',()=>{
  const doc=legacy();upsert(doc,input({title:'Unrelated requirement'}));const p=createProposal(doc,{title:'Aspect proposal'});
  editProposalRequirement(doc,p.id,{...input(),id:'TG-001',tags:['mcp']});
  upsert(doc,{...input(),id:'TG-001',tags:['security']});upsert(doc,{...input({title:'Unrelated latest'}),id:'TG-002',tags:['reliability']});doc.requirementsVersion++;
  assert.throws(()=>submitProposal(doc,p.id),/Refresh/);assert.deepEqual(proposalConflicts(doc,p),['TG-001']);
  assert.throws(()=>rebaseProposal(doc,p.id,{}),/every conflicting/);
  rebaseProposal(doc,p.id,{'TG-001':'proposed'});assert.equal(p.status,'Draft');assert.deepEqual(p.requirements[0].tags,['mcp']);assert.equal(p.requirements[0].revision,3);assert.deepEqual(p.requirements[1].tags,['reliability']);
});

test('legacy import preserves frozen field absence, normalized identity and nonempty assignments',()=>{
  const doc=legacy();doc.baselines.push({id:'BL-001',name:'Original baseline',date:new Date().toISOString(),requirements:structuredClone(doc.requirements),sections:structuredClone(doc.sections)});
  const oldSnapshot=JSON.stringify(doc.baselines);const equivalent=structuredClone(doc);equivalent.requirements[0].tags=[];
  reconcileWorkspace(doc,equivalent);assert.equal(doc.requirements[0].revision,1);assert.equal(JSON.stringify(doc.baselines),oldSnapshot);
  upsert(doc,{...input(),id:'TG-001',tags:['mcp']});
  const before=structuredClone(doc),omitted=structuredClone(doc);delete omitted.requirements[0].tags;omitted.requirements[0].revision++;
  assert.throws(()=>reconcileWorkspace(doc,omitted),/TG-001: include tags explicitly/);assert.deepEqual(doc,before);
  const invalid=structuredClone(doc);invalid.requirements[0].tags=['invalid!'];assert.throws(()=>reconcileWorkspace(doc,invalid),/TG-001: Tag 1/);assert.deepEqual(doc,before);
  const altered=structuredClone(doc);altered.baselines[0].requirements[0].tags=[];assert.throws(()=>reconcileWorkspace(doc,altered),/existing baselines/);
  const clear=structuredClone(doc);clear.requirements[0].tags=[];assert.throws(()=>reconcileWorkspace(doc,clear),/revision/);clear.requirements[0].revision++;assert.throws(()=>reconcileWorkspace(doc,clear),/Draft proposal/);assert.deepEqual(doc,before);assert.equal(JSON.stringify(doc.baselines),oldSnapshot);
  snapshot(doc,'New snapshot');assert.deepEqual(doc.baselines[0].requirements[0].tags,['mcp']);
});

test('filters combine exact Any/All, Untagged, text and context; counts exclude tag restriction',()=>{
  const base=legacy().requirements[0];const reqs=[{...base,id:'TG-001',tags:['mcp','security']},{...base,id:'TG-002',status:'Approved',tags:['mcp']},{...base,id:'TG-003',section:'other',tags:['reliability']},{...base,id:'TG-004'}];
  const ids=f=>reqs.filter(r=>matchesRequirement(r,f)).map(r=>r.id);
  assert.deepEqual(ids({tags:['mcp','security']}),['TG-001','TG-002']);assert.deepEqual(ids({tags:['mcp','security'],tag_mode:'all'}),['TG-001']);
  assert.deepEqual(ids({tags:['sec']}),[]);assert.deepEqual(ids({query:'SECUR'}),['TG-001']);assert.deepEqual(ids({untagged_only:true}),['TG-004']);
  assert.deepEqual(ids({tags:['mcp'],status:'Draft',section:'section'}),['TG-001']);assert.equal(ids({tags:[],tag_mode:'all'}).length,4);
  assert.deepEqual(tagInventory(reqs,{status:'Draft',section:'section',tags:['reliability']}),[{tag:'mcp',count:1},{tag:'reliability',count:0},{tag:'security',count:1}]);
  assert.deepEqual(tagInventory([base]),[]);
});

test('legacy MCP reads synthesize current arrays but preserve exact snapshots and never save',async()=>{
  const doc=legacy();doc.baselines.push({id:'BL-001',name:'Legacy snapshot',date:new Date().toISOString(),requirements:structuredClone(doc.requirements),sections:structuredClone(doc.sections)});const before=structuredClone(doc);
  const store={read:async()=>structuredClone(doc),commit:async()=>{throw Error('Read must not commit');}},actor={id:'qa'};
  const get=await callTool(store,'get_requirement',{project_id:doc.id,requirement_id:'TG-001'},actor,'read');assert.deepEqual(get.requirement.tags,[]);toolMap.get('get_requirement').output.parse(get);
  const list=await callTool(store,'list_requirements',{project_id:doc.id},actor,'read');assert.deepEqual(list.items[0].tags,[]);toolMap.get('list_requirements').output.parse(list);
  const frozen=await callTool(store,'get_snapshot',{project_id:doc.id,baseline_id:'BL-001'},actor,'read');assert.deepEqual(frozen.snapshot,doc.baselines[0]);toolMap.get('get_snapshot').output.parse(frozen);assert.deepEqual(doc,before);
  // A valid imported historical label is not rewritten to satisfy a current-only schema.
  doc.baselines[0].requirements[0].tags=[' MCP '];
  const imported=await callTool(store,'get_snapshot',{project_id:doc.id,baseline_id:'BL-001'},actor,'read');toolMap.get('get_snapshot').output.parse(imported);assert.deepEqual(imported.snapshot.requirements[0].tags,[' MCP ']);
});
