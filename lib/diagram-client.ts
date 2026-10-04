import diagramWorkerUrl from './diagram.worker.ts?worker&url';
import type {DiagramBlock} from './types';
import {DIAGRAM_LIMITS} from './diagrams';
import {sanitizedSvg} from './content-sanitizer';
type Result={svg?:string;error?:string};
type Job={block:DiagramBlock;deliver:(result:Result)=>void;cancelled:boolean;stop?:()=>void};
const pending:Job[]=[],cache=new Map<string,string>();let active=0,cacheSize=0;
function pump(){while(active<2&&pending.length){const job=pending.shift()!;if(job.cancelled)continue;active++;let worker:Worker|undefined,done=false;
 const finish=(result?:Result)=>{if(done)return;done=true;clearTimeout(timer);worker?.terminate();active--;if(result&&!job.cancelled)job.deliver(result);pump();};
 const timer=setTimeout(()=>finish({error:`Rendering exceeded ${DIAGRAM_LIMITS.timeout} ms. Simplify the diagram; source is preserved.`}),DIAGRAM_LIMITS.timeout);job.stop=()=>finish();
 try{worker=new Worker(diagramWorkerUrl,{type:'module'});worker.onmessage=e=>{if(done||job.cancelled)return;try{if(e.data.error){finish({error:String(e.data.error)});return;}const svg=sanitizedSvg(e.data.svg),key=JSON.stringify([job.block.language,job.block.source]);if(!cache.has(key)){while(cacheSize+svg.length>4_000_000&&cache.size){const first=cache.keys().next().value!;cacheSize-=cache.get(first)!.length;cache.delete(first);}cache.set(key,svg);cacheSize+=svg.length;}finish({svg});}catch(error){finish({error:(error as Error).message});}};worker.onerror=()=>finish({error:'Diagram renderer unavailable. Original source is preserved.'});worker.postMessage(job.block);}catch{finish({error:'Diagram renderer unavailable. Original source is preserved.'});}
 }}
/** A maximum of two isolated renderers run at once. Cache is presentation only,
 * bounded to 4 MB, and sanitized again on every reuse. Cancellation releases a
 * slot immediately and stale worker messages cannot populate it. */
export function renderDiagram(block:DiagramBlock,deliver:(r:Result)=>void){const key=JSON.stringify([block.language,block.source]),cached=cache.get(key);if(cached){try{deliver({svg:sanitizedSvg(cached)});}catch(error){deliver({error:(error as Error).message});}return()=>{};}
 const job:Job={block,deliver,cancelled:false};pending.push(job);pump();return()=>{job.cancelled=true;job.stop?.();const index=pending.indexOf(job);if(index>=0)pending.splice(index,1);};}
