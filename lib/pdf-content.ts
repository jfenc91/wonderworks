import {contentParts,formatOf} from './item-content';
import {sanitizedBody,sanitizedSvg} from './content-sanitizer';
import {renderDiagram} from './diagram-client';
import {PDF_LIMITS,safePdfLink,type Block,type Run,type PdfSource,type PdfModel} from './pdf-model';

function inline(node:Node, style:Partial<Run>={}):Run[] {
  if(node.nodeType===3)return [{...style,text:node.textContent??''}];
  if(!(node instanceof Element))return [];
  const tag=node.tagName.toLowerCase();
  if(tag==='br')return [{...style,text:'\n'}];
  const next={...style,...(['b','strong'].includes(tag)?{bold:true}:{}),...(['em','i'].includes(tag)?{italic:true}:{}),...(tag==='code'?{code:true}:{}),...(tag==='a'?{href:safePdfLink(node.getAttribute('href')??'')}:{})};
  return Array.from(node.childNodes).flatMap(n=>inline(n,next));
}
const blockTags=new Set(['p','div','h1','h2','h3','h4','h5','h6','pre','ul','ol','table','blockquote','hr']);
function blocks(parent:Pick<Node,'childNodes'>):Block[] {
  const result:Block[]=[],pending:Run[]=[];
  const flush=()=>{if(pending.some(r=>r.text.trim()))result.push({type:'text',runs:pending.splice(0)});else pending.length=0;};
  for(const node of Array.from(parent.childNodes)){
    if(!(node instanceof Element)||!blockTags.has(node.tagName.toLowerCase())){pending.push(...inline(node));continue;}
    flush();const tag=node.tagName.toLowerCase();
    if(tag==='ul'||tag==='ol')result.push({type:'list',ordered:tag==='ol',start:Number(node.getAttribute('start'))||1,items:Array.from(node.children).filter(n=>n.tagName==='LI').map(n=>blocks(n))});
    else if(tag==='table'){
      // Expand spans into an explicit logical grid. Values appear once; covered
      // cells point to their origin rather than duplicating authored prose.
      const rows:Array<{header:boolean;cells:Block[][]}>=[],occupied=new Map<string,string>();
      const trs=Array.from(node.querySelectorAll('tr')).filter(tr=>tr.closest('table')===node);
      trs.forEach((tr,y)=>{const cells:Block[][]=[];let x=0;
        const covered=()=>{while(occupied.has(`${y}:${x}`)){cells.push([{type:'text',runs:[{text:occupied.get(`${y}:${x}`)!}]}]);x++;}};
        for(const cell of Array.from(tr.children).filter(c=>['TD','TH'].includes(c.tagName))){covered();const colspan=Math.max(1,Math.min(100,Number(cell.getAttribute('colspan'))||1)),rowspan=Math.max(1,Math.min(trs.length-y,Number(cell.getAttribute('rowspan'))||1));const label=`Continued cell from row ${y+1}, column ${x+1}`;
          cells.push(blocks(cell));for(let dy=0;dy<rowspan;dy++)for(let dx=0;dx<colspan;dx++)if(dx||dy)occupied.set(`${y+dy}:${x+dx}`,label);x++;covered();}
        covered();rows.push({header:Array.from(tr.children).some(c=>c.tagName==='TH'),cells});});
      result.push({type:'table',rows,caption:node.querySelector('caption')?.textContent??undefined});
    }else if(tag==='pre')result.push({type:'text',literal:true,size:9.5,role:'Code',runs:[{text:node.textContent??'',code:true}]});
    else if(/^h[1-6]$/.test(tag))result.push({type:'text',role:'H3',size:14,runs:inline(node).map(r=>({...r,bold:true}))});
    else if(tag!=='hr')result.push(...blocks(node));
  }
  flush();return result;
}
export async function preparePdf(source:PdfSource,signal:AbortSignal,onProgress:(message:string)=>void):Promise<PdfModel>{
  const model:PdfModel={source,items:[],warnings:[]};let count=0;
  for(const requirement of source.requirements){
    signal.throwIfAborted();onProgress(`Preparing ${requirement.id}`);const output:Block[]=[];
    for(const part of contentParts(requirement)){
      if(part.type==='body'){
        if(formatOf(requirement)==='plain_text')output.push({type:'text',literal:true,runs:[{text:part.source}]});
        else {const clean=sanitizedBody(part.source,formatOf(requirement) as 'html'|'markdown');const template=document.createElement('template');template.innerHTML=clean.html;output.push(...blocks(template.content));if(clean.warning)model.warnings.push(`${requirement.id}: unsafe HTML was removed by the content policy.`);}
      }else {
        if(++count>PDF_LIMITS.diagrams)throw Error(`PDF export supports ${PDF_LIMITS.diagrams} diagrams. Use the existing source export.`);
        const b=part.block,result=await new Promise<{svg?:string;error?:string}>((resolve,reject)=>{
          let stop=()=>{};const abort=()=>{stop();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
          stop=renderDiagram(b,r=>{signal.removeEventListener('abort',abort);resolve(r);},JSON.stringify(['pdf-v1',source.projectId,source.context,source.version,source.paper]));if(signal.aborted)abort();
        });
        const figure:Extract<Block,{type:'figure'}>={type:'figure',id:b.id,title:part.inline?'Title not authored':b.title||'Title not authored',alt:part.inline?'Text alternative not authored':b.alt||'Text alternative not authored',source:b.source};
        if(result.svg){const svg=sanitizedSvg(result.svg),xml=new DOMParser().parseFromString(svg,'image/svg+xml'),root=xml.documentElement;
          const box=(root.getAttribute('viewBox')??'').trim().split(/[ ,]+/).map(Number);figure.svg=svg;figure.width=box[2]||parseFloat(root.getAttribute('width')??'0');figure.height=box[3]||parseFloat(root.getAttribute('height')??'0');
          figure.minFont=Math.min(14,...Array.from(xml.querySelectorAll('text')).map(n=>parseFloat(n.getAttribute('font-size')??'14')));
          if(!figure.width||!figure.height||!Number.isFinite(figure.minFont)||figure.minFont<=0){figure.svg=undefined;figure.error='Invalid figure dimensions.';}
        }else figure.error=result.error??'Renderer unavailable.';
        if(figure.error)model.warnings.push(`${requirement.id} / ${b.id}: ${figure.error} Complete source is included.`);
        output.push(figure);
      }
    }
    model.items.push({requirement,blocks:output});
    // Allow input, navigation and cancellation between potentially large items.
    await new Promise(r=>setTimeout(r,0));
  }
  return model;
}
