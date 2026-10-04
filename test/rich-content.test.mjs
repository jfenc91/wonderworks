import test from 'node:test';
import assert from 'node:assert/strict';
import {requirementInput,exportSpecification,reconcileWorkspace} from '../lib/requirements.ts';
import {createProposal,editProposalRequirement,submitProposal,reviewProposal,requirementChanges,proposalConflicts,rebaseProposal,sameRequirement} from '../lib/workflow.ts';
import {stage} from '../lib/mcp/service.ts';
import {recordEvidence} from '../lib/evidence.ts';
import {contentSize,validateItem,diagramsOf,sourceFreshness,reverseSummaries,sourceFence,normative} from '../lib/item-content.ts';
import {parseMermaid,validateDot,validateDiagrams} from '../lib/diagrams.ts';
import {matchesRequirement} from '../lib/tags.ts';
import {toolMap} from '../lib/mcp/contracts.ts';
const workspace=()=>({id:'rich',name:'Rich content',prefix:'RC',version:0,requirementsVersion:1,sections:[{id:'s',title:'Content',description:''}],requirements:[],baselines:[],evidence:[],history:[],proposals:[]});
const req=(extra={})=>({section:'s',title:'Normative behavior',description:'  α😀 &amp; <tag>\n\n\tkept exactly  \n',criteria:['A measurable result.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
const block=(extra={})=>({id:'diagram-main',language:'mermaid',source:'flowchart LR\n A[Start] -->|yes| B[Finish]',title:'Overview',alt:'Start leads to finish.',position:0,...extra});
const info=(extra={})=>req({kind:'information',criteria:[],description:'Summary narrative',summarizes:[],diagrams:[block()],...extra});
const accept=doc=>{submitProposal(doc,doc.proposals[0].id);reviewProposal(doc,doc.proposals[0].id,{decision:'apply'});};
const fields=r=>{const {id,revision,...v}=r;return v;};
test('formats preserve exact Unicode source and share a code-point budget with diagram metadata',()=>{
 for(const body_format of ['plain_text','markdown','html']){const r=requirementInput.parse(req({body_format}));assert.equal(r.description,req().description);validateItem(r);}
 validateItem(requirementInput.parse(req({description:'😀'.repeat(50000)})));
 assert.throws(()=>validateItem(requirementInput.parse(req({description:'😀'.repeat(50001)}))),/50000/);
 assert.equal(contentSize(info({description:'😀',diagrams:[block({source:'界',title:'a',alt:'b'})]})),4);
 assert.throws(()=>validateItem(info({description:'x'.repeat(49999)})),/50000/);
 assert.throws(()=>validateItem(req({description:' \n',diagrams:[]})),/non-whitespace/);
 validateItem(req({description:' \n',diagrams:[block()]}));
 assert.throws(()=>requirementInput.parse(req({body_format:'rtf'})));
 assert.throws(()=>validateItem(info({criteria:['No placeholder']})),/Information/);
 assert.throws(()=>validateItem(info({status:'Implemented'})),/Editorial|editorial/);
});
test('Markdown fences have one authoritative source, stable opt-in IDs, and explicit positions across formats',()=>{
 const source='Intro\n\n```mermaid id=flow\nflowchart LR\n A-->B\n```\n\n```graphviz id=dot\ndigraph{a->b}\n```\n';
 const r=req({body_format:'markdown',description:source});assert.deepEqual(diagramsOf(r).map(d=>d.id),['flow','dot']);assert.equal(r.description,source);
 assert.equal(diagramsOf({...r,body_format:'plain_text'}).length,0);
 for(const body_format of ['markdown','html','plain_text'])assert.equal(diagramsOf(req({body_format,diagrams:[block(),block({id:'second',position:3,language:'dot',source:'graph{a--b}'})]})).length,2);
 assert.throws(()=>validateItem({...r,diagrams:[block({id:'flow'})]}),/unique/);
 const fenced=sourceFence('~~~\n``````\n</script>','html');assert.ok(fenced.startsWith('```````html\n'));assert.ok(fenced.endsWith('```````'));
});
test('both diagram languages validate supported fixtures and reject syntax, unsafe features and complexity',()=>{
 for(const s of ['flowchart TD\n subgraph group[Group]\n A[Start] -->|yes| B{Ready}\n end\n B --> C(Finish)','sequenceDiagram\n participant A as Alice\n participant B as Bob\n A->>B: Request\n B-->>A: Response','stateDiagram-v2\n [*] --> Ready\n Ready --> Done: complete\n Done --> [*]'])assert.ok(parseMermaid(s).nodes.length);
 for(const s of ['digraph G {a[label="A"];a->b[label="next"]}','graph G {a--b}','digraph G {subgraph cluster_one {label="Group";a;b;}a->b}'])assert.equal(validateDot(s).type,'Dot');
 for(const s of ['flowchart TD\n broken -->','pie\n A:1','flowchart TD\n click A "https://bad.example"','%%{init:{}}%%\nflowchart TD\n A-->B','flowchart TD\n A[<img src=x>]','flowchart TD\n'+Array.from({length:101},(_,i)=>'N'+i).join('\n')])assert.throws(()=>parseMermaid(s));
 for(const s of ['digraph { a -> }','digraph {a[image="https://bad.example/a"]}','digraph{a[URL="javascript:alert(1)"]}','digraph{a[fontsize=99999]}','digraph{a[unknown=1]}','graph{a->b}','digraph{{a b}->{c d}}'])assert.throws(()=>validateDot(s));
});
test('ten-source batches resolve forward refs, version all fields, preserve omitted fields and reject invalid final sets',()=>{
 const d=workspace(),p=createProposal(d,{title:'Ten source summary'});
 const operations=[{op:'add',client_ref:'summary',requirement:info({summarizes:Array.from({length:10},(_,i)=>({requirement_id:'$r'+i})),diagram_mappings:[{block_id:'diagram-main',part:'A',requirement_ids:['$r0','$r9']}],body_format:'markdown'})},...Array.from({length:10},(_,i)=>({op:'add',client_ref:'r'+i,requirement:req({title:'Source '+i})}))];
 stage(d,p.id,operations);const summary=p.requirements[0];assert.equal(p.requirements.length,11);assert.equal(summary.summarizes.length,10);assert.ok(summary.summarizes.every(s=>s.reviewed_revision===1));assert.deepEqual(summary.diagram_mappings[0].requirement_ids,['RC-002','RC-011']);assert.equal(d.requirements.length,0);
 accept(d);const frozen=JSON.stringify(d.baselines[0]);assert.equal(d.requirements.filter(normative).length,10);assert.equal(reverseSummaries('RC-002',d.requirements)[0].id,'RC-001');
 assert.throws(()=>recordEvidence(d,{baseline:d.baselines[0].id,artifactUrl:'https://example.com',summary:'Not a verification target',checks:[{id:'RC-001',title:'Wrong',passed:true,detail:''}]}),/reference a requirement/);
 const next=createProposal(d,{title:'Edit source and narrative'});const original=next.requirements[0];const legacy={...fields(original)};for(const k of ['kind','body_format','diagrams','summarizes','diagram_mappings'])delete legacy[k];legacy.title='Legacy title edit';stage(d,next.id,[{op:'edit',requirement_id:original.id,requirement:legacy}]);assert.equal(next.requirements[0].kind,'information');assert.deepEqual(next.requirements[0].diagrams,original.diagrams);assert.equal(next.requirements[0].revision,2);
 stage(d,next.id,[{op:'edit',requirement_id:'RC-002',requirement:req({title:'Source changed'})}]);assert.equal(sourceFreshness(next.requirements[0].summarizes[0],next.requirements),'Needs review');
 const staleMarker=structuredClone(next.requirements[0].summarizes);stage(d,next.id,[{op:'edit',requirement_id:'RC-001',requirement:{...fields(next.requirements[0]),title:'Another summary edit'}}]);assert.deepEqual(next.requirements[0].summarizes,staleMarker);assert.equal(next.requirements[0].revision,2);accept(d);assert.equal(JSON.stringify(d.baselines[1]),frozen);
 for(const operation of [{op:'delete',requirement_id:'RC-002'},{op:'edit',requirement_id:'RC-001',requirement:{...fields(d.requirements[0]),summarizes:[]}},{op:'edit',requirement_id:'RC-002',requirement:req({links:['RC-001']})}]){const copy=structuredClone(d),p=createProposal(copy,{title:'Invalid final references'});assert.throws(()=>stage(copy,p.id,[operation]),/source|summarizes|dependency/);}
 const p3=createProposal(d,{title:'Explicit source review'});const sr=p3.requirements[0];stage(d,p3.id,[{op:'edit',requirement_id:sr.id,requirement:{...fields(sr),summarizes:sr.summarizes.map(s=>({...s,reviewed_revision:d.requirements.find(r=>r.id===s.requirement_id).revision}))}}]);assert.equal(sourceFreshness(p3.requirements[0].summarizes[0],p3.requirements),'Reviewed');accept(d);assert.equal(JSON.stringify(d.baselines[2]),frozen);
});
test('review markers compare final staged revisions; stale summaries may remain and bad diagrams stay Draft',()=>{
 const d=workspace(),p=createProposal(d,{title:'Wrong review marker'});stage(d,p.id,[{op:'add',client_ref:'r',requirement:req()},{op:'add',client_ref:'s',requirement:info({summarizes:[{requirement_id:'$r',reviewed_revision:42}]})}]);assert.throws(()=>submitProposal(d,p.id),/final staged revision/);assert.equal(p.status,'Draft');
 stage(d,p.id,[{op:'edit',requirement_id:'RC-002',requirement:info({summarizes:[{requirement_id:'RC-001',reviewed_revision:1}],diagrams:[block({source:'flowchart TD\n ???'})]})}]);assert.throws(()=>submitProposal(d,p.id),/RC-002, block diagram-main/);assert.equal(p.status,'Draft');assert.match(p.requirements[1].diagrams[0].source,/\?\?\?/);
 stage(d,p.id,[{op:'edit',requirement_id:'RC-002',requirement:info({summarizes:[{requirement_id:'RC-001',reviewed_revision:1}]})}]);accept(d);
 assert.equal(sourceFreshness({requirement_id:'RC-001'},d.requirements),'Unknown');
});
test('rich diffs, source whitespace, rebase conflicts, restore and exact legacy snapshots',()=>{
 const d=workspace(),p=createProposal(d,{title:'Start rich content'});stage(d,p.id,[{op:'add',client_ref:'r',requirement:req({body_format:'html'})}]);accept(d);const legacy=structuredClone(d);delete legacy.requirements[0].kind;delete legacy.requirements[0].body_format;delete legacy.baselines[0].requirements[0].kind;delete legacy.baselines[0].requirements[0].body_format;const before=JSON.stringify(legacy.baselines);reconcileWorkspace(legacy,structuredClone(legacy));assert.equal(JSON.stringify(legacy.baselines),before);
 const a=createProposal(d,{title:'Body format branch'}),b=createProposal(d,{title:'Whitespace branch'});stage(d,a.id,[{op:'edit',requirement_id:'RC-001',requirement:req({body_format:'markdown'})}]);stage(d,b.id,[{op:'edit',requirement_id:'RC-001',requirement:req({description:req().description+' ',body_format:'html'})}]);submitProposal(d,b.id);reviewProposal(d,b.id,{decision:'apply'});assert.deepEqual(proposalConflicts(d,a),['RC-001']);assert.throws(()=>rebaseProposal(d,a.id,{}));rebaseProposal(d,a.id,{'RC-001':'proposed'});assert.equal(a.status,'Draft');assert.ok(requirementChanges(a.baseRequirements,a.requirements)[0].fields.includes('body_format'));stage(d,a.id,[{op:'restore',requirement_id:'RC-001'}]);assert.ok(sameRequirement(a.requirements[0],a.baseRequirements[0]));assert.equal(a.requirements[0].revision,a.baseRequirements[0].revision);
});
test('search, kind/status combination, export source boundaries and complete-spec MCP schema',()=>{
 const r=info({id:'RC-010',revision:2,body_format:'html',description:'<p>Hello <b>readable</b>&#32;world &amp; things</p>',summarizes:[{requirement_id:'RC-001',reviewed_revision:1}],diagrams:[block({title:'Special label'})]});
 for(const query of ['hello readable world','Special label','RC-001','Start'])assert.ok(matchesRequirement(r,{query}));assert.ok(matchesRequirement(r,{kind:'information'}));assert.ok(!matchesRequirement(r,{status:'Draft'}));
 const d=workspace();d.requirements=[{...req(),id:'RC-001',revision:2},r];const output=exportSpecification(d);for(const value of ['Information','Format: html','```html','```mermaid','Text alternative:','Needs review','reviewed 1','current 2'])assert.ok(output.includes(value),value);assert.ok(output.includes(r.description));
 const schema=toolMap.get('list_requirements').definition.inputSchema;assert.deepEqual(schema.properties.kind.enum,['requirement','information']);assert.match(toolMap.get('list_requirements').description,/omit kind/);assert.ok(toolMap.get('stage_proposal_changes').definition.inputSchema.properties.operations);
 const destructive=structuredClone(d);delete destructive.requirements[1].body_format;assert.throws(()=>reconcileWorkspace(d,destructive),/Draft proposal/);
});
