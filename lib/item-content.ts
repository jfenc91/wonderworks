import {decodeHTML} from 'entities';
import type {Requirement,DiagramBlock,SummarySource} from './types';
import {marked} from 'marked';
export const CONTENT_LIMIT=50_000;
export const richFields=['kind','body_format','diagrams','summarizes','diagram_mappings'] as const;
export const kindOf=(r:Pick<Requirement,'kind'>)=>r.kind??'requirement';
export const formatOf=(r:Pick<Requirement,'body_format'>)=>r.body_format??'plain_text';
export const normative=(r:Pick<Requirement,'kind'>)=>kindOf(r)==='requirement';
export const codePoints=(text:string)=>Array.from(text).length;
export const contentSize=(r:Partial<Requirement>)=>codePoints(r.description??'')+(r.diagrams??[]).reduce((n,d)=>n+codePoints(d.source)+codePoints(d.title)+codePoints(d.alt),0);
export type ContentPart={type:'body';source:string}|{type:'diagram';block:DiagramBlock;inline?:boolean};
/** Top-level fences retain their exact original source in description. Explicit
 * blocks use a code-point offset; ties retain array order. No renderer writes. */
export function contentParts(r:Partial<Requirement>):ContentPart[]{
 const body=r.description??'',parts:ContentPart[]=[],points=Array.from(body);
 const explicit=[...(r.diagrams??[])].sort((a,b)=>a.position-b.position);
 let cursor=0;
 const bodyParts=(source:string)=>{
  if(formatOf(r)!=='markdown'){if(source)parts.push({type:'body',source});return;}
  let ordinal=0;
  for(const token of marked.lexer(source,{gfm:true})){
   const m=token.type==='code'&&token.lang?.match(/^(mermaid|dot|graphviz)(?:\s+id=([A-Za-z][\w-]{0,63}))?\s*$/i);
   if(m){const id=m[2]??`fence-${++ordinal}-${cursor}`;parts.push({type:'diagram',inline:true,block:{id,language:m[1].toLowerCase()==='mermaid'?'mermaid':'dot',source:token.text,title:`${m[1]} diagram`,alt:'Original diagram source is available below.',position:cursor}});}
   else {const previous=parts.at(-1);if(previous?.type==='body')previous.source+=token.raw;else parts.push({type:'body',source:token.raw});}
  }
 };
 for(const d of explicit){const at=Math.min(points.length,Math.max(cursor,d.position));bodyParts(points.slice(cursor,at).join(''));parts.push({type:'diagram',block:d});cursor=at;}
 bodyParts(points.slice(cursor).join(''));return parts;
}
export const diagramsOf=(r:Partial<Requirement>)=>contentParts(r).flatMap(p=>p.type==='diagram'?[p.block]:[]);
export function inheritRich<T extends Partial<Requirement>>(data:T,existing?:Requirement):T{
 const result={...data};for(const field of richFields)if(result[field]===undefined&&existing?.[field]!==undefined)(result as any)[field]=structuredClone(existing[field]);
 if(!existing){result.kind??='requirement';result.body_format??='plain_text';result.diagrams??=[];result.summarizes??=[];result.diagram_mappings??=[];}return result;
}
export function validateItem(r:Partial<Requirement>){
 const prefix=r.id??'Item';
 if(contentSize(r)>CONTENT_LIMIT)throw Error(`${prefix}: body and diagram content exceeds ${CONTENT_LIMIT} Unicode code points`);
 if(!(r.description??'').trim()&&!(r.diagrams??[]).some(d=>d.source.trim()))throw Error(`${prefix}: provide non-whitespace body source or a nonempty diagram block`);
 if(normative(r)&&!r.criteria?.length)throw Error(`${prefix}: a requirement needs 1–20 acceptance criteria`);
 if(!normative(r)&&((r.criteria??[]).length||Object.keys(r.parameters??{}).length||(r.links??[]).length))throw Error(`${prefix}: Information has no acceptance criteria, implementation parameters or dependencies`);
 if(!normative(r)&&r.status==='Implemented')throw Error(`${prefix}: Information uses editorial Draft or Approved status, never Implemented`);
 if(normative(r)&&((r.summarizes??[]).length||(r.diagram_mappings??[]).length))throw Error(`${prefix}: summarizes and source mappings belong to Information elements`);
 const blocks=diagramsOf(r),ids=blocks.map(d=>d.id);
 if(new Set(ids).size!==ids.length)throw Error(`${prefix}: diagram IDs must be unique across explicit blocks and Markdown fences`);
 for(const d of r.diagrams??[])if(d.position>codePoints(r.description??''))throw Error(`${prefix}, block ${d.id}: position exceeds body code-point length`);
}
export function validateReferences(items:Requirement[]){
 const byId=new Map(items.map(r=>[r.id,r]));
 for(const r of items){
  for(const id of r.links)if(id===r.id||!byId.has(id)||!normative(byId.get(id)!))throw Error(`${r.id}: dependency ${id} must reference another existing normative requirement`);
  const sources=r.summarizes??[],ids=sources.map(s=>s.requirement_id);
  if(new Set(ids).size!==ids.length)throw Error(`${r.id}: duplicate summarizes reference`);
  for(const id of ids)if(id===r.id||!byId.has(id)||!normative(byId.get(id)!))throw Error(`${r.id}: summarizes ${id} must reference another existing normative requirement`);
  const blocks=new Set(diagramsOf(r).map(d=>d.id)),keys=new Set<string>();
  for(const m of r.diagram_mappings??[]){
   if(!blocks.has(m.block_id))throw Error(`${r.id}: mapping block ${m.block_id} is missing`);
   const key=JSON.stringify([m.block_id,m.part]);if(keys.has(key))throw Error(`${r.id}: duplicate mapping for ${m.block_id}/${m.part}`);keys.add(key);
   if(new Set(m.requirement_ids).size!==m.requirement_ids.length)throw Error(`${r.id}: duplicate mapped source`);
   for(const id of m.requirement_ids)if(!ids.includes(id))throw Error(`${r.id}, block ${m.block_id}, part ${m.part}: mapped source ${id} must be in Sources`);
  }
 }
}
export function initializeSourceReviews(items:Requirement[],before:Requirement[]){
 for(const r of items){const old=before.find(o=>o.id===r.id);for(const s of r.summarizes??[])if(!old?.summarizes?.some(o=>o.requirement_id===s.requirement_id)&&s.reviewed_revision===undefined){const source=items.find(i=>i.id===s.requirement_id);if(source)s.reviewed_revision=source.revision;}}
}
export function validateReviewMarkers(items:Requirement[],base:Requirement[]){
 for(const r of items)for(const s of r.summarizes??[]){
  const old=base.find(o=>o.id===r.id)?.summarizes?.find(o=>o.requirement_id===s.requirement_id);
  if(s.reviewed_revision!==undefined&&s.reviewed_revision!==old?.reviewed_revision&&s.reviewed_revision!==items.find(i=>i.id===s.requirement_id)?.revision)throw Error(`${r.id}: reviewed source ${s.requirement_id} must name its final staged revision. Retain the prior marker to deliberately leave Needs review.`);
 }
}
export function sourceFreshness(s:SummarySource,items:Requirement[]){const current=items.find(r=>r.id===s.requirement_id);return !current||s.reviewed_revision===undefined?'Unknown':current.revision===s.reviewed_revision?'Reviewed':'Needs review';}
export const reverseSummaries=(id:string,items:Requirement[])=>items.filter(r=>!normative(r)&&r.summarizes?.some(s=>s.requirement_id===id));
export function readableText(source:string){return decodeHTML(source.replace(/<[^>]*>/g,' ')).replace(/[*_`#>|]/g,' ').replace(/\s+/g,' ').trim();}
export const itemSearchText=(r:Requirement)=>[r.id,r.title,r.description,readableText(r.description),...r.criteria,...(r.diagrams??[]).flatMap(d=>[d.title,d.alt,d.source]),...(r.summarizes??[]).map(s=>s.requirement_id),...(r.diagram_mappings??[]).map(m=>m.part)].join(' ');
export function sourceFence(source:string,language='text'){const n=Math.max(2,...(source.match(/`+/g)??[]).map(v=>v.length))+1;const fence='`'.repeat(n);return `${fence}${language}\n${source}\n${fence}`;}

export const markdownLabel=(text:string)=>text.replace(/[\\`*_{}\[\]()#+.!|<>]/g, c=>'\\'+c).replace(/\r?\n/g,' ');
