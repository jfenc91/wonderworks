import DOMPurify from 'dompurify';
import {marked} from 'marked';
const tags=['p','br','strong','b','em','i','s','del','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','pre','code','table','thead','tbody','tfoot','tr','th','td','hr','a','span','div','sub','sup','caption'];
export function sanitizedBody(source:string,format:'markdown'|'html'){
 const raw=format==='markdown'?marked.parse(source,{gfm:true,async:false}):source;
 const html=DOMPurify.sanitize(raw,{ALLOWED_TAGS:tags,ALLOWED_ATTR:['href','title','colspan','rowspan','scope','start'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false});
 const removed=DOMPurify.removed.some(entry=>!('element' in entry)||entry.element?.nodeName!=='BODY');
 // Scheme and credential checks complement DOMPurify's URI filtering.
 const container=document.createElement('template');container.innerHTML=html;
 for(const a of container.content.querySelectorAll('a')){const href=a.getAttribute('href')??'';try{const url=new URL(href,location.origin);if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw Error();a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer');}catch{a.removeAttribute('href');}}
 return {html:container.innerHTML,warning:removed||container.innerHTML!==html&&/javascript:|data:|file:|@/i.test(raw)};
}
export function sanitizedSvg(raw:string){
 if(raw.length>1_000_000)throw Error('Generated diagram exceeds output limit');
 const html=DOMPurify.sanitize(raw,{ALLOWED_TAGS:['svg','g','path','polygon','polyline','rect','circle','ellipse','line','text','tspan','defs','marker','title','desc'],ALLOWED_ATTR:['xmlns','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','transform','fill','stroke','stroke-width','stroke-dasharray','stroke-linecap','stroke-linejoin','text-anchor','font-size','font-family','id','marker-end','marker-start','markerWidth','markerHeight','refX','refY','orient'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false});
 const xml=new DOMParser().parseFromString(html,'image/svg+xml');if(xml.querySelector('parsererror')||xml.documentElement.tagName!=='svg')throw Error('Renderer did not return safe SVG');
 for(const el of Array.from(xml.querySelectorAll('*')))for(const attr of Array.from(el.attributes)){if(/url\s*\(/i.test(attr.value)&&!/^url\(#[A-Za-z][\w-]*\)$/.test(attr.value))el.removeAttribute(attr.name);if(['fill','stroke'].includes(attr.name)&&!/^#[0-9a-f]{3,8}$|^[a-z]+$|^url\(#[A-Za-z][\w-]*\)$/i.test(attr.value))el.removeAttribute(attr.name);}
 if(!xml.querySelector('path,polygon,polyline,rect,circle,ellipse,line,text'))throw Error('Renderer returned no safe visible content. Original source is preserved.');
 const box=xml.documentElement.getAttribute('viewBox');if(box){const values=box.trim().split(/[ ,]+/).map(Number);if(values.length!==4||values.some(v=>!Number.isFinite(v))||values[2]<=0||values[3]<=0||values[2]>24000||values[3]>24000)throw Error('Generated diagram dimensions exceed the 24000-pixel limit');}
 return new XMLSerializer().serializeToString(xml.documentElement);
}
