'use client';
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {Download} from 'lucide-react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import type {Workspace} from '@/lib/types';
import {capturePdfSource,PDF_LIMITS,type Paper,type PdfSource} from '@/lib/pdf-model';
import pdfWorkerUrl from '@/lib/pdf.worker.ts?worker&url';

type Result={phase:'preparing'|'ready'|'warning'|'failed'|'cancelled';label:string;message:string;url?:string;filename?:string;warnings?:string[]};
type ExportApi={busy:boolean;start:(source:PdfSource)=>void;status:ReactNode};
const Context=createContext<ExportApi|null>(null);
export function PdfExportProvider({children}:{children:ReactNode}){
  const [result,setResult]=useState<Result|null>(null),job=useRef<{id:number;preparing:boolean;controller:AbortController;worker?:Worker;timer?:ReturnType<typeof setTimeout>;url?:string;expiry?:ReturnType<typeof setTimeout>}|null>(null),sequence=useRef(0);
  function release(){const active=job.current;if(!active)return;active.controller.abort();active.worker?.terminate();clearTimeout(active.timer);clearTimeout(active.expiry);if(active.url)URL.revokeObjectURL(active.url);job.current=null;}
  useEffect(()=>()=>{const active=job.current;active?.controller.abort();active?.worker?.terminate();clearTimeout(active?.timer);clearTimeout(active?.expiry);if(active?.url)URL.revokeObjectURL(active.url);},[]);
  function save(url:string,filename:string){const link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();}
  function start(source:PdfSource){
    if(job.current?.preparing)return;
    release();const current={id:++sequence.current,preparing:true,controller:new AbortController()} as NonNullable<typeof job.current>;job.current=current;
    const label=`${source.projectName} · ${source.context} · ${source.paper==='LETTER'?'US Letter':'A4'}`;
    const live=()=>job.current===current&&!current.controller.signal.aborted;
    const failed=(message:string)=>{if(!live())return;release();setResult({phase:'failed',label,message});};
    setResult({phase:'preparing',label,message:'Preparing PDF'});
    current.timer=setTimeout(()=>failed('PDF preparation exceeded 120 seconds. Try again, or use the Markdown or JSON export.'),PDF_LIMITS.milliseconds);
    void (async()=>{
      try{
        // Let the accessible Preparing state paint before parsing saved content.
        await new Promise(r=>setTimeout(r,0));const {preparePdf}=await import('@/lib/pdf-content');
        const model=await preparePdf(source,current.controller.signal,message=>{if(live())setResult({phase:'preparing',label,message});});if(!live())return;
        const worker=new Worker(pdfWorkerUrl,{type:'module'});current.worker=worker;
        worker.onerror=()=>failed('PDF renderer unavailable. Reload and retry; source exports remain available.');
        worker.onmessage=event=>{
          if(!live())return;
          if(event.data.progress){setResult({phase:'preparing',label,message:event.data.progress});return;}
          if(event.data.error){failed(String(event.data.error));return;}
          const data=event.data.data as Uint8Array;
          if(!(data instanceof Uint8Array)||data.length<100||new TextDecoder().decode(data.slice(0,5))!=='%PDF-'){failed('PDF assembly returned an invalid file. Retry the export.');return;}
          clearTimeout(current.timer);worker.terminate();current.worker=undefined;current.preparing=false;
          model.warnings=event.data.warnings??model.warnings;
          const url=URL.createObjectURL(new Blob([data as BlobPart],{type:'application/pdf'}));current.url=url;
          current.expiry=setTimeout(()=>{if(job.current===current){release();setResult({phase:'cancelled',label,message:'The temporary download expired after 10 minutes. Download PDF again to capture the saved source.'});}},600_000);
          setResult({phase:model.warnings.length?'warning':'ready',label,message:model.warnings.length?'Completed with rendering warnings':'Ready',url,filename:source.filename,warnings:model.warnings});
          try{save(url,source.filename);}catch{setResult({phase:model.warnings.length?'warning':'ready',label,message:'Automatic saving was blocked. Use Download again.',url,filename:source.filename,warnings:model.warnings});}
        };worker.postMessage({model});
      }catch(error){if(live())failed(error instanceof Error?error.message:'PDF preparation failed. Retry the export.');}
    })();
  }
  const status=result&&<aside className="pdf-job" aria-label="PDF download progress"><div role="status" aria-live="polite"><strong>{result.phase==='preparing'?'Preparing PDF':result.phase==='warning'?'Completed with rendering warnings':result.phase==='failed'?'Failed':result.phase==='cancelled'?'Cancelled':'Ready'}</strong><p>{result.label}</p><p>{result.message}</p></div>{!!result.warnings?.length&&<details><summary>{result.warnings.length} rendering warnings</summary><ul>{result.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>}<div>{result.phase==='preparing'?<button className="secondary" onClick={()=>{release();setResult({phase:'cancelled',label:result.label,message:'Generation cancelled. No file was downloaded.'});}}>Cancel PDF</button>:<>{result.url&&<a className="secondary" href={result.url} download={result.filename}>Download again</a>}<button className="ghost" onClick={()=>{release();setResult(null);}}>Dismiss PDF result</button></>}</div></aside>;
  return <Context.Provider value={{busy:result?.phase==='preparing',start,status}}>{children}</Context.Provider>;
}

export function PdfJobStatus(){return useContext(Context)?.status;}

export function PdfDownload({doc,snapshotId}:{doc:Workspace;snapshotId?:string}){
  const api=useContext(Context),[open,setOpen]=useState(false),[paper,setPaper]=useState<Paper>('A4'),[error,setError]=useState('');
  const snapshot=snapshotId?doc.baselines.find(b=>b.id===snapshotId):undefined,empty=!(snapshot?.requirements??doc.requirements).length;
  const context=snapshotId?`Snapshot ${snapshotId} · ${snapshot?.name??'Unavailable'}`:`Latest accepted · set v${doc.requirementsVersion??'Unknown'} · workspace v${doc.version}`;
  return <><button className="secondary" onClick={()=>{setError('');setOpen(true);}} aria-label={snapshotId?`Download PDF ${snapshotId}`:'Download PDF'}><Download size={15}/>Download PDF</button><Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>Download PDF</DialogTitle><DialogDescription>{doc.name} · {context}</DialogDescription><p>Complete saved specification. All saved requirements and Information are included, regardless of search, filters, or pagination. Pending proposals and unsaved input are excluded.</p><label className="pdf-paper">Paper size<select aria-label="PDF paper size" value={paper} onChange={e=>setPaper(e.target.value as Paper)}><option value="A4">A4</option><option value="LETTER">US Letter</option></select></label><p>Document language: English (en, default).</p>{empty&&<p role="status">This specification is empty. Save items before exporting a PDF.</p>}{error&&<p className="error-box" role="alert">{error}</p>}<div className="editor-actions"><button className="ghost" onClick={()=>setOpen(false)}>Close</button><button className="primary" disabled={empty||api?.busy} onClick={()=>{try{const source=capturePdfSource(doc,paper,snapshotId);api?.start(source);setOpen(false);}catch(error){setError(error instanceof Error?error.message:'Unable to prepare this specification.');}}}>{api?.busy?'Preparing PDF':'Download PDF'}</button></div></DialogContent></Dialog></>;
}
