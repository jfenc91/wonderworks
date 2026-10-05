'use client';
import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from './ui/dialog';
type Preview={archive_id:string;fingerprint:string;projects:{id:string;name:string;version:number;items:number;proposals:number;snapshots:number;history_events:number;conflict:boolean}[];warnings:string[]};
const pendingImportKey='wonderworks.pending-import.v1';
export function WorkspaceTransfer({project,onOpenProject}:{project:string;onOpenProject:(id:string)=>void}){
  const [open,setOpen]=useState(false),[scope,setScope]=useState('current'),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<Preview|null>(null),[modes,setModes]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[result,setResult]=useState<{id:string;name:string}[]>([]),[download,setDownload]=useState('');
  const [uncertain,setUncertain]=useState(false);
  const controller=useRef<AbortController|null>(null),operation=useRef(''),downloadRef=useRef('');
  useEffect(()=>()=>{controller.current?.abort();if(downloadRef.current)URL.revokeObjectURL(downloadRef.current);},[]);
  function replaceDownload(url:string){if(downloadRef.current)URL.revokeObjectURL(downloadRef.current);downloadRef.current=url;setDownload(url);}
  async function run(action:'export'|'preview'|'import'){
    const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setResult([]);setMessage(action==='export'?'Capturing committed workspace versions…':action==='preview'?'Uploading and validating archive…':'Validating and importing selected workspaces…');
    try{
      if(action==='export'){
        const r=await fetch('/api/workspace-archive?scope='+encodeURIComponent(scope==='all'?'all':project),{signal:abort.signal,cache:'no-store'});if(!r.ok)throw Error(((await r.json()) as {error?:string}).error??'Export failed.');
        const reader=r.body?.getReader();if(!reader)throw Error('Download unavailable.');const chunks:Uint8Array[]=[];let count=0;
        while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>32*1024*1024){await reader.cancel();throw Error('Archive exceeds 32 MiB.');}chunks.push(value);setMessage(`Downloading ${(count/1024/1024).toFixed(1)} MiB…`);}
        const url=URL.createObjectURL(new Blob(chunks as BlobPart[],{type:'application/zip'}));replaceDownload(url);const a=document.createElement('a');a.href=url;a.download='wonderworks-workspaces.wwspace';a.click();
        const versions=JSON.parse(r.headers.get('x-workspace-versions')??'[]') as {id:string;version:number}[];setMessage(`Ready: ${r.headers.get('x-workspace-count')} workspace(s). Saved versions: ${versions.map(p=>p.id+' v'+p.version).join(', ')}.`);
      }else{
        if(!file)throw Error('Choose a .wwspace archive.');if(file.size>32*1024*1024)throw Error('Choose an archive no larger than 32 MiB.');
        const selection=Object.entries(modes).filter(([,mode])=>mode!=='skip').map(([id,mode])=>({id,mode}));
        if(action==='import'&&!selection.length)throw Error('Select at least one project.');
        if(!operation.current)operation.current=crypto.randomUUID();
        if(action==='import'){setUncertain(true);try{sessionStorage.setItem(pendingImportKey,JSON.stringify({fingerprint:preview?.fingerprint,selection,operation:operation.current}));}catch{/* The in-memory operation still permits an identical retry. */}}
        const r=await fetch('/api/workspace-archive?action='+action,{method:'POST',headers:{'Content-Type':'application/zip',...(action==='import'?{'X-Workspace-Operation':operation.current,'X-Workspace-Selection':JSON.stringify(selection)}:{})},body:file,signal:abort.signal});
        const data=await r.json() as Preview&{error?:string};if(!r.ok)throw Error(data.error??'Transfer failed.');
        if(action==='preview'){
          setPreview(data);const defaults=Object.fromEntries(data.projects.map(p=>[p.id,p.conflict?'skip':'restore']));let recovered=false;
          try{const pending=JSON.parse(sessionStorage.getItem(pendingImportKey)??'null') as {fingerprint:string;selection:{id:string;mode:string}[];operation:string}|null;if(pending?.fingerprint===data.fingerprint){setModes({...Object.fromEntries(data.projects.map(p=>[p.id,'skip'])),...Object.fromEntries(pending.selection.map(p=>[p.id,p.mode]))});operation.current=pending.operation;setUncertain(true);recovered=true;}}catch{/* Ignore unavailable or invalid local recovery metadata. */}
          if(!recovered)setModes(defaults);setMessage(recovered?'Recovered an uncertain import. Retry to retrieve its original outcome.':'Archive validated. Choose the projects and destination modes below.');
        }
        else {setUncertain(false);try{sessionStorage.removeItem(pendingImportKey);}catch{}setResult(data.projects);setMessage('Import complete. Historical assertions are labeled as imported provenance.');}
      }
    }catch(e){setError(abort.signal.aborted?(action==='import'?'Transfer interrupted. If publication already committed, retrying this same file and selection returns the original projects.':'Transfer cancelled.'):(e instanceof Error?e.message:'Transfer failed.'));setMessage('');}
    finally{setBusy(false);controller.current=null;}
  }
  return <><button className="secondary" onClick={()=>setOpen(true)}>Workspace backup &amp; import</button><Dialog open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}><DialogContent className="workspace-transfer"><DialogTitle>Workspace backup &amp; import</DialogTitle><DialogDescription>Transfer complete saved projects, including open proposals and history. Specification exports remain available in the project toolbar.</DialogDescription>
    <section><h3>Export workspace</h3><label>Export scope<select aria-label="Export workspace scope" disabled={busy} value={scope} onChange={e=>setScope(e.target.value)}><option value="current">Current project</option><option value="all">All accessible projects</option></select></label><button className="primary" disabled={busy} onClick={()=>void run('export')}>Export workspace</button>{download&&<a className="secondary" href={download} download="wonderworks-workspaces.wwspace">Download archive again</a>}<p className="field-hint">Captures saved data only. Maximum archive: 32 MiB compressed, 64 MiB expanded, 50 projects.</p></section>
    <section><h3>Import workspace</h3><label>Workspace archive<input type="file" accept=".wwspace" disabled={busy||uncertain} onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null);setResult([]);operation.current='';setError('');}}/></label><button className="secondary" disabled={busy||!file||uncertain} onClick={()=>void run('preview')}>Preview archive</button>
      {preview&&<><p>Archive {preview.archive_id}</p><ul>{preview.warnings.map(w=><li key={w}>{w}</li>)}</ul>{preview.projects.map(p=><label className="archive-project" key={p.id}><strong>{p.name}</strong><span>{p.id} · workspace v{p.version} · {p.items} items · {p.proposals} proposals · {p.snapshots} snapshots · {p.history_events} history events</span><span>{p.conflict?'This ID already exists. Import a copy or skip.':'This ID is available for exact restore.'}</span><select aria-label={'Import mode for '+p.name} disabled={busy||uncertain} value={modes[p.id]} onChange={e=>{setModes({...modes,[p.id]:e.target.value});operation.current='';}}><option value="skip">Skip</option>{!p.conflict&&<option value="restore">Restore original ID</option>}<option value="copy">Import as a separate copy</option></select></label>)}<button className="primary" disabled={busy||!!result.length} onClick={()=>void run('import')}>{uncertain?'Retry same import':'Confirm selected imports'}</button></>}
      {result.map(p=><button className="secondary" key={p.id} onClick={()=>{setOpen(false);onOpenProject(p.id);}}>Open {p.name}</button>)}
    </section>{message&&<p role="status" aria-live="polite">{message}</p>}{error&&<p className="error-box" role="alert">{error}</p>}{busy&&<button className="secondary" onClick={()=>controller.current?.abort()}>Cancel transfer</button>}{!busy&&uncertain&&<button className="secondary" onClick={()=>{setUncertain(false);operation.current='';try{sessionStorage.removeItem(pendingImportKey);}catch{}setPreview(null);setFile(null);setError('Check the project selector for a completed import before starting a new operation.');}}>Inspect projects before starting another import</button>}
  </DialogContent></Dialog></>;
}
export function ImportedProvenance({project}:{project:string}){
  const [provenance,setProvenance]=useState<{source_project:string;source_archive:string;imported_at:string;imported_by:string;historical_assertions:string}|null>(null);
  useEffect(()=>{const abort=new AbortController();void fetch('/api/workspace-archive?provenance='+encodeURIComponent(project),{signal:abort.signal,cache:'no-store'}).then(r=>r.ok?r.json():null).then(value=>setProvenance(value as typeof provenance)).catch(()=>{});return()=>abort.abort();},[project]);
  if(!provenance)return null;
  return <aside className="imported-provenance"><strong>Imported workspace</strong><p>{provenance.historical_assertions}</p><details><summary>Source and import event</summary><p>Source project: {provenance.source_project}. Archive: {provenance.source_archive}. Imported {provenance.imported_at} by {provenance.imported_by}.</p></details></aside>;
}
