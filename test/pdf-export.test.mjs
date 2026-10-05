import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {capturePdfSource,PDF_LIMITS,safePdfLink} from '../lib/pdf-model.ts';
import {buildPdf,PDF_FONTS} from '../lib/pdf-engine.ts';
import {parseMermaid} from '../lib/diagrams.ts';
const requirement={id:'PF-001',section:'s',title:'Complete legacy item',description:'Literal <body> **source**',criteria:['Preserve all content'],parameters:{count:1,enabled:false},links:['PF-404'],status:'Approved',priority:'High',revision:1};
const workspace={id:'pdf-fixture',name:'Unsafe / path \\ name.pdf',requirements:[requirement],sections:[{id:'s',title:'Saved section',description:'Saved description'}],version:2,requirementsVersion:3,proposals:[{requirements:[{...requirement,description:'Pending content'}]}],baselines:[{id:'BL-001',name:'Legacy frozen context',date:'2020-01-01',requirements:[{...requirement,status:'Draft'}],sections:[{id:'s',title:'Old section',description:'Old description'}]}]};
test('dashed sequence arrows retain the authored participants and endpoints',()=>{
 const graph=parseMermaid('sequenceDiagram\n participant client-app as Client\n participant B as Service\n client-app->>B: Request\n B-->>client-app: Response');
 assert.deepEqual(graph.nodes.map(n=>n.id),['client-app','B']);assert.equal(graph.edges[1].from,'B');assert.equal(graph.edges[1].to,'client-app');assert.equal(graph.edges[1].dashed,true);
});
test('PDF capture freezes only the full saved context and preserves unknown historical metadata',()=>{
 const before=structuredClone(workspace),accepted=capturePdfSource(workspace,'A4'),snapshot=capturePdfSource(workspace,'LETTER','BL-001');
 assert.equal(accepted.requirements[0].description,requirement.description);assert.equal(accepted.workspaceVersion,2);assert.equal(snapshot.version,undefined);assert.equal(snapshot.workspaceVersion,undefined);assert.equal(snapshot.requirements[0].status,'Draft');assert.equal(snapshot.sections[0].title,'Old section');assert.match(accepted.filename,/accepted-v3\.pdf$/);assert.ok(!/[\\/]/.test(accepted.filename));
 accepted.requirements[0].description='Derived change';snapshot.sections[0].description='Derived change';assert.deepEqual(workspace,before);
 assert.throws(()=>capturePdfSource(workspace,'A4','missing'),/unavailable/);
 assert.throws(()=>capturePdfSource({...workspace,requirements:[]},'A4'),/empty/);
 assert.throws(()=>capturePdfSource({...workspace,requirements:Array(PDF_LIMITS.items+1).fill(requirement)},'A4'),/2000 items/);
 assert.throws(()=>capturePdfSource({...workspace,requirements:[{...requirement,description:'x'.repeat(PDF_LIMITS.inputBytes)}]},'A4'),/20 MB/);
});
test('PDF links reject unsafe, relative, credential-bearing and active URLs',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,hello','file:///etc/passwd','https://user:password@example.com','//example.com','/current-item'])assert.equal(safePdfLink(url),undefined);
 assert.equal(safePdfLink('https://example.com/path?q=1'),'https://example.com/path?q=1');
});
test('Legacy, Information-only and failed figures produce complete tagged offline PDFs',async()=>{
 const fonts=Object.fromEntries(await Promise.all(Object.entries(PDF_FONTS).map(async([name,file])=>[name,new Uint8Array(await readFile(new URL('../public/fonts/'+file,import.meta.url)))])));
 const source=capturePdfSource(workspace,'A4','BL-001');
 const b={type:'figure',id:'broken',title:'Saved failed title',alt:'Saved failed alternative',source:'flowchart TD\n ???',error:'Unsupported diagram syntax'};
 const model={source,items:[{requirement:source.requirements[0],blocks:[{type:'text',literal:true,runs:[{text:requirement.description}]},b]}],warnings:['PF-001 / broken: Unsupported diagram syntax. Complete source is included.']};
 const bytes=await buildPdf(model,fonts);assert.equal(new TextDecoder().decode(bytes.slice(0,5)),'%PDF-');await mkdir('outputs/pdf',{recursive:true});await writeFile('outputs/pdf/legacy-fallback.pdf',bytes);
 const info={...requirement,kind:'information',title:'Information only',criteria:[],parameters:{},links:[]};const informational=capturePdfSource({...workspace,requirements:[info]},'LETTER');
 await writeFile('outputs/pdf/information-only.pdf',await buildPdf({source:informational,items:[{requirement:info,blocks:[{type:'text',runs:[{text:'Non-normative information remains exportable.'}]}]}],warnings:[]},fonts));
 const unsupported={type:'figure',id:'oversize',title:'Large figure',alt:'Complete source fallback',source:'digraph { a -> b }',svg:'<svg viewBox="0 0 24000 24000"><rect width="24000" height="24000"/></svg>',width:24000,height:24000,minFont:14};const limited={source,items:[{requirement,blocks:[unsupported]}],warnings:[]};
 await buildPdf(limited,fonts);assert.match(limited.warnings[0],/100-detail-page limit/);assert.equal(unsupported.svg,undefined);
});
