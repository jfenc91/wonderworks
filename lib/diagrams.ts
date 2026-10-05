import {parse as parseDot} from '@ts-graphviz/ast';
import type {DiagramBlock,Requirement} from './types';
import {diagramsOf,codePoints} from './item-content';
export const DIAGRAM_LIMITS={source:12000,nodes:100,edges:200,groups:12,depth:8,statements:400,timeout:2500,output:1_000_000};
export type GraphNode={id:string;label:string;shape?:'box'|'diamond'|'ellipse';group?:string};
export type GraphEdge={from:string;to:string;label:string;dashed?:boolean;directed?:boolean;thick?:boolean};
export type DiagramGraph={type:'graph'|'sequence';direction:'TB'|'BT'|'LR'|'RL';nodes:GraphNode[];edges:GraphEdge[];groups:{id:string;label:string}[]};
function fail(message:string):never{throw Error(message);}
function checkSource(source:string){
 if(!source.trim())fail('Diagram source is empty');
 if(codePoints(source)>DIAGRAM_LIMITS.source)fail(`Diagram source limit is ${DIAGRAM_LIMITS.source} Unicode code points`);
 // No directives, markup, remote assets, executable callbacks or file reads.
 if(/%%\{|^\s*---|\b(?:click|href|url|image|imagepath|shapefile|include|stylesheet|fontpath|icon|callback|classDef|linkStyle)\b|<\/?[A-Za-z]|(?:javascript|data|file|https?):/im.test(source))fail('Unsupported external resource, markup, style, callback or renderer directive');
 if((source.match(/[\n;]/g)??[]).length>DIAGRAM_LIMITS.statements)fail(`Diagram statement limit is ${DIAGRAM_LIMITS.statements}`);
 let depth=0;for(const c of source){if(c==='{')depth++;if(depth>DIAGRAM_LIMITS.depth)fail(`Diagram nesting limit is ${DIAGRAM_LIMITS.depth}`);if(c==='}')depth--;}
}
function limited(g:DiagramGraph){if(g.nodes.length>DIAGRAM_LIMITS.nodes||g.edges.length>DIAGRAM_LIMITS.edges||g.groups.length>DIAGRAM_LIMITS.groups)fail(`Diagram complexity limit: ${DIAGRAM_LIMITS.nodes} nodes, ${DIAGRAM_LIMITS.edges} edges, ${DIAGRAM_LIMITS.groups} groups`);return g;}
function statements(source:string){
 const out:string[]=[];let start=0,quote=false,brackets=0;
 for(let i=0;i<source.length;i++){const c=source[i];if(c==='"'&&source[i-1]!=='\\')quote=!quote;if(!quote){if(c==='['||c==='(')brackets++;if(c===']'||c===')')brackets--;if((c==='\n'||c===';')&&brackets===0){out.push(source.slice(start,i).trim());start=i+1;}}}
 if(quote||brackets!==0)fail('Unclosed diagram label');out.push(source.slice(start).trim());return out.filter(s=>s&&!s.startsWith('%%'));
}
/** Wonderworks Mermaid core v1. Deliberately finite grammar shared by submit and
 * worker rendering; unsupported constructs fail visibly instead of disappearing. */
export function parseMermaid(source:string):DiagramGraph{
 checkSource(source);const lines=statements(source),header=lines.shift()??'';
 const g:DiagramGraph={type:header==='sequenceDiagram'?'sequence':'graph',direction:'TB',nodes:[],edges:[],groups:[]};
 const flow=header.match(/^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)$/),state=/^stateDiagram(?:-v2)?$/.test(header);
 if(!flow&&!state&&g.type!=='sequence')fail('Supported Mermaid headers: flowchart TD/LR/BT/RL, sequenceDiagram, stateDiagram-v2');
 if(flow)g.direction=flow[1]==='TD'?'TB':flow[1] as DiagramGraph['direction'];
 let group:string|undefined;
 function node(id:string,label?:string,shape:GraphNode['shape']='box'){
  if(id==='[*]')id='__start';if(!/^[A-Za-z_][\w-]*$/.test(id))fail('Use simple letter/number node IDs');
  const old=g.nodes.find(n=>n.id===id);if(old){if(label)old.label=label;return id;}g.nodes.push({id,label:label??(id==='__start'?'●':id==='__end'?'◉':id),shape,...(group?{group}:{})});limited(g);return id;
 }
 function endpoint(raw:string){const m=raw.trim().match(/^(\[\*\]|[A-Za-z_][\w-]*)(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/);if(!m)fail('Unsupported node syntax: '+raw.slice(0,100));const label=m[2]??m[3]??m[4];return node(m[1],label?.replace(/^"|"$/g,''),m[4]!==undefined?'diamond':m[3]!==undefined?'ellipse':'box');}
 for(const line of lines){
  if(g.type==='sequence'){
   const p=line.match(/^(?:participant|actor)\s+([\w-]+)(?:\s+as\s+(.+))?$/);
   if(p){node(p[1],p[2]);continue;}
   const e=line.match(/^([\w-]+?)\s*(--?>>|--?>|--?x|--?\))\s*([\w-]+)\s*:\s*(.+)$/);
   if(!e)fail('Unsupported sequence statement: '+line.slice(0,100));g.edges.push({from:node(e[1]),to:node(e[3]),label:e[4],dashed:e[2].startsWith('--')});limited(g);continue;
  }
  const sub=line.match(/^subgraph\s+([\w-]+)(?:\s*\[([^\]]+)\])?$/);
  if(sub){if(group)fail('Nested Mermaid groups are not supported');group=sub[1];g.groups.push({id:group,label:sub[2]??group});limited(g);continue;}
  if(line==='end'){if(!group)fail('Unexpected end');group=undefined;continue;}
  if(state){
   const label=line.match(/^state\s+"([^"]+)"\s+as\s+([\w-]+)$/)||line.match(/^([\w-]+)\s*:\s*(.+)$/)?.map((v,i,a)=>i===1?a[2]:i===2?a[1]:v);
   if(label){node(label[2],label[1]);continue;}
   const e=line.match(/^(\[\*\]|[\w-]+)\s*-->\s*(\[\*\]|[\w-]+)(?:\s*:\s*(.*))?$/);
   if(e){g.edges.push({from:node(e[1]==='[*]'?'__start':e[1]),to:node(e[2]==='[*]'?'__end':e[2]),label:e[3]??''});limited(g);continue;}
   if(/^[\w-]+$/.test(line)){node(line);continue;}fail('Unsupported state statement: '+line.slice(0,100));
  }
  // Core flow syntax supports chained arrows and pipe labels. Match arrows only
  // outside node labels so literal punctuation in labels stays authoritative.
  const pieces:string[]=[];let start=0,depth=0,quoted=false;
  for(let i=0;i<line.length;i++){const c=line[i];if(c==='"')quoted=!quoted;if(quoted)continue;if('[({'.includes(c))depth++;if('])}'.includes(c))depth--;if(depth===0){const arrow=line.slice(i).match(/^(-->|---|-\.->|==>)(?:\|([^|]*)\|)?/);if(arrow){pieces.push(line.slice(start,i),arrow[0]);i+=arrow[0].length-1;start=i+1;}}}pieces.push(line.slice(start));
  if(pieces.length===1){endpoint(line);continue;}
  for(let i=0;i+2<pieces.length;i+=2){const arrow=pieces[i+1];g.edges.push({from:endpoint(pieces[i]),to:endpoint(pieces[i+2]),label:arrow.match(/\|([^|]*)\|/)?.[1]??'',dashed:arrow.startsWith('-.'),directed:!arrow.startsWith('---'),thick:arrow.startsWith('==')});limited(g);}
 }
 if(group)fail('Unclosed subgraph');if(!g.nodes.length)fail('Diagram has no nodes');return limited(g);
}
export function validateDot(source:string){
 checkSource(source);let ast:any;try{ast=parseDot(source);}catch(e){fail('DOT syntax: '+(e as Error).message.slice(0,250));}
 const roots=ast.children??ast.body??[];if(roots.filter((v:any)=>v.type==='Graph'||v.type==='graph').length!==1)fail('Provide exactly one Graphviz graph');
 const root=roots.find((v:any)=>String(v.type).toLowerCase()==='graph');
 const syntax=source.replace(/"(?:\\.|[^"\\])*"/g,'""').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'');
 if(root.directed?/--(?!>)/.test(syntax):/->/.test(syntax))fail('DOT edge operator does not match graph/digraph');
 const nodeIds=new Set<string>();let edges=0,groups=0,count=0;
 const visit=(value:any)=>{if(!value||typeof value!=='object')return;if(++count>10000)fail('DOT syntax complexity limit exceeded');const type=String(value.type).toLowerCase();if(type==='node'||type==='noderef')nodeIds.add(value.id?.value);if(type==='edge'){if(value.targets.some((t:any)=>String(t.type).toLowerCase()!=='noderef'))fail('Grouped edge endpoints are unsupported; use explicit node-to-node edges');edges+=value.targets.length-1;}if(type==='subgraph')groups++;
  if(type==='attribute'){const key=String(value.key?.value??'').toLowerCase();const allowed=['label','shape','rankdir','rank','color','fillcolor','fontcolor','fontsize','style','penwidth','arrowhead','arrowtail','dir'];if(!allowed.includes(key))fail('Unsupported DOT attribute: '+key);if(key==='fontsize'&&(Number(value.value?.value)<6||Number(value.value?.value)>48))fail('DOT font size must be 6–48');}
  for(const [key,v] of Object.entries(value))if(key!=='location')if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);
 };visit(ast);if(nodeIds.size>DIAGRAM_LIMITS.nodes||edges>DIAGRAM_LIMITS.edges||groups>DIAGRAM_LIMITS.groups)fail('DOT complexity limit exceeded');return ast;
}
export function validateDiagram(d:DiagramBlock){if(d.language==='mermaid')parseMermaid(d.source);else validateDot(d.source);}
export function diagramErrors(items:Requirement[]){return items.flatMap(r=>diagramsOf(r).flatMap(d=>{try{validateDiagram(d);return [];}catch(e){return [{item:r.id,block:d.id,message:(e as Error).message}];}}));}
export function validateDiagrams(items:Requirement[]){const errors=diagramErrors(items);if(errors.length)throw Error('Blocking diagram errors: '+errors.map(e=>`${e.item}, block ${e.block}: ${e.message}`).join('; '));}
