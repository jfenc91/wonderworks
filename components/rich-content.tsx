'use client';
import {renderDiagram} from '@/lib/diagram-client';
import {useEffect,useRef,useState} from 'react';
import type {Requirement,DiagramBlock} from '@/lib/types';
import {contentParts,formatOf,kindOf,sourceFreshness,reverseSummaries,normative} from '@/lib/item-content';
import {sanitizedBody} from '@/lib/content-sanitizer';
export function DiagramView({block}:{block:DiagramBlock}){
 const [result,setResult]=useState<{key:string;svg?:string;error?:string}>(),[scale,setScale]=useState(1),[copied,setCopied]=useState(false);
 const key=JSON.stringify([block.language,block.source]);
 useEffect(()=>renderDiagram(block,result=>setResult({key,...result})),[key]);
 const current=result?.key===key?result:undefined;
 return <figure className="diagram-block" data-block-id={block.id}><figcaption><strong>{block.title||'Untitled diagram'}</strong><span>{block.language==='dot'?'Graphviz DOT':'Mermaid'} · {block.id}</span></figcaption><p>{block.alt||'No text alternative supplied. Original source is available.'}</p>{current?.error?<p className="error-box" role="status">Block {block.id}: {current.error}</p>:current?.svg?<><label className="diagram-scale">Diagram scale<select aria-label={'Scale '+block.id} value={scale} onChange={e=>setScale(Number(e.target.value))}><option value={1}>Fit width</option><option value={2}>200%</option><option value={4}>400%</option></select></label><div className="diagram-scroll" tabIndex={0} aria-label={'Diagram '+block.title}><div role="img" aria-label={block.alt||block.title} style={{width:scale===1?'100%':`${scale*100}%`}} dangerouslySetInnerHTML={{__html:current.svg}}/></div></>:<p role="status">Rendering diagram…</p>}<details open={!!current?.error}><summary>Original diagram source</summary><pre>{block.source}</pre><button type="button" className="ghost" onClick={()=>void navigator.clipboard.writeText(block.source).then(()=>setCopied(true))}>{copied?'Copied':'Copy diagram source'}</button></details></figure>;
}
function Body({source,format}:{source:string;format:ReturnType<typeof formatOf>}){
 const [result,setResult]=useState<{key:string;html:string;warning:boolean}>();const key=format+source;
 useEffect(()=>{if(format==='plain_text')return;const value=sanitizedBody(source,format);
  // Add trusted keyboard scrolling controls after sanitization, preserving table semantics.
  const root=document.createElement('template');root.innerHTML=value.html;
  root.content.querySelectorAll('table').forEach((table,index)=>{
   const scroll=document.createElement('div');scroll.className='rich-scroll';scroll.tabIndex=0;
   scroll.setAttribute('role','region');scroll.setAttribute('aria-label',`Scrollable table ${index+1}`);
   table.replaceWith(scroll);scroll.appendChild(table);
  });
  root.content.querySelectorAll('pre').forEach((pre,index)=>{
   pre.tabIndex=0;pre.setAttribute('role','region');pre.setAttribute('aria-label',`Scrollable code block ${index+1}`);
  });
  setResult({key,...value,html:root.innerHTML});},[key,format,source]);
 if(format==='plain_text')return <pre className="plain-body">{source}</pre>;
 if(result?.key!==key)return <p role="status">Preparing rendered content…</p>;
 return <>{result.warning&&<p className="content-warning" role="status">Preview removed unsafe or unsupported HTML. Original source is unchanged.</p>}<div className="semantic-body" dangerouslySetInnerHTML={{__html:result.html}}/></>;
}
export function RichContent({item,showSource=true}:{item:Partial<Requirement>;showSource?:boolean}){
 const format=formatOf(item);let parts;try{parts=contentParts(item);}catch{return <div className="rich-content"><p className="error-box">Preview unavailable. Original source is preserved.</p><pre>{item.description}</pre></div>;}
 return <div className="rich-content" data-format={format}><p className="content-format">{kindOf(item)==='information'?'Information · ':''}{format.replace('_',' ')}</p>{parts.map((part,i)=>part.type==='diagram'?<DiagramView key={part.block.id} block={part.block}/>:<Body key={'body-'+i} source={part.source} format={format}/>)}{showSource&&<details><summary>Original body source · {format}</summary><pre>{item.description}</pre></details>}</div>;
}
export function SourceLinks({item,items,context,onSelect}:{item:Requirement;items:Requirement[];context:string;onSelect:(id:string)=>void}){
 const reverse=reverseSummaries(item.id,items);
 return <section className="source-links" aria-label={'Sources for '+item.id}>{!!item.summarizes?.length&&<><h4>Sources</h4><p>{context} · Review freshness does not establish semantic accuracy or verification.</p><ul>{item.summarizes.map(s=>{const r=items.find(r=>r.id===s.requirement_id);return <li key={s.requirement_id}><button className="dependency-link" onClick={()=>onSelect(s.requirement_id)}>{s.requirement_id} · {r?.title??'Unavailable'} · r{r?.revision??'?'}</button><span className={'source-freshness '+(sourceFreshness(s,items)==='Needs review'?'stale':'')}>{sourceFreshness(s,items)} · reviewed r{s.reviewed_revision??'Unknown'}</span></li>;})}</ul></>}{!!item.diagram_mappings?.length&&<><h4>Diagram source navigation</h4>{item.diagram_mappings.map(m=><div key={m.block_id+':'+m.part}><strong>{m.block_id} · {m.part}</strong>{m.requirement_ids.map(id=><button key={id} className="dependency-link" aria-label={`${m.part}: ${id}`} onClick={()=>onSelect(id)}>{id} · {items.find(r=>r.id===id)?.title??'Unavailable'}</button>)}</div>)}</>}{normative(item)&&reverse.length>0&&<><h4>Summarized by</h4><p>{context}</p>{reverse.map(r=><button className="dependency-link" key={r.id} onClick={()=>onSelect(r.id)}>{r.id} · {r.title} · Information</button>)}</>}</section>;
}
