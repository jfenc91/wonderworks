'use client';
import {useEffect,useRef,useState} from 'react';
import {Archive,Download,Upload,FileArchive,CheckCircle2,LoaderCircle} from 'lucide-react';
import {validateArchiveDownload} from '@/lib/archive-download.mjs';
type Preview={archive_id:string;fingerprint:string;projects:{id:string;name:string;version:number;items:number;proposals:number;snapshots:number;history_events:number;conflict:boolean;deleted?:boolean}[];warnings:string[]};
const pendingImportKey='wonderworks.pending-import.v1';
export function WorkspaceTransfer({project,onOpenProject}:{project:string;onOpenProject:(id:string)=>void}){
  const [scope,setScope]=useState('current'),[file,setFile]=useState<File|null>(null),[preview,setPreview]=useState<Preview|null>(null),[modes,setModes]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[result,setResult]=useState<{id:string;name:string}[]>([]),[download,setDownload]=useState('');
  const [uncertain,setUncertain]=useState(false);
  const controller=useRef<AbortController|null>(null),operation=useRef(''),downloadRef=useRef('');
  useEffect(()=>()=>{controller.current?.abort();if(downloadRef.current)URL.revokeObjectURL(downloadRef.current);},[]);
  function replaceDownload(url:string){if(downloadRef.current)URL.revokeObjectURL(downloadRef.current);downloadRef.current=url;setDownload(url);}
  async function run(action:'export'|'preview'|'import'){
    const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setResult([]);setMessage(action==='export'?'Capturing committed workspace versions…':action==='preview'?'Uploading and validating archive…':'Validating and importing selected workspaces…');
    try{
      if(action==='export'){
        replaceDownload('');
        const r=await fetch('/api/workspace-archive?scope='+encodeURIComponent(scope==='all'?'all':project),{signal:abort.signal,cache:'no-store'});if(!r.ok){const failure=r.headers.get('content-type')?.includes('application/json')?await r.json() as {error?:string}:null;throw Error(failure?.error??`Workspace export failed (HTTP ${r.status}). Please retry.`);}
        const reader=r.body?.getReader();if(!reader)throw Error('Download unavailable.');const chunks:Uint8Array[]=[];let count=0;
        while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>32*1024*1024){await reader.cancel();throw Error('Archive exceeds 32 MiB.');}chunks.push(value);setMessage(`Downloading ${(count/1024/1024).toFixed(1)} MiB…`);}
        setMessage('Checking archive download…');
        const blob=new Blob(chunks as BlobPart[],{type:'application/zip'});await validateArchiveDownload(blob,abort.signal);
        const url=URL.createObjectURL(blob);replaceDownload(url);const a=document.createElement('a');a.href=url;a.download='wonderworks-workspaces.wwspace';a.click();
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
  return <section className="settings-card workspace-transfer" aria-labelledby="workspace-transfer-title">
    <header className="settings-card-header"><span className="settings-icon"><Archive size={21} aria-hidden="true"/></span><div><h3 id="workspace-transfer-title">Workspace backup &amp; import</h3><p>Keep a complete backup or bring your projects to another workspace.</p></div><span className="settings-badge">.wwspace</span></header>
    <div className="transfer-grid">
      <section className="transfer-action" aria-labelledby="workspace-export-title">
        <div className="transfer-action-title"><Download size={19} aria-hidden="true"/><h4 id="workspace-export-title">Export workspace</h4></div>
        <p>Download saved requirements, open proposals, snapshots and history.</p>
        <label className="settings-field">Export scope<select aria-label="Export workspace scope" disabled={busy} value={scope} onChange={e=>setScope(e.target.value)}><option value="current" disabled={!project}>Current project</option><option value="all">All accessible projects</option></select></label>
        <div className="transfer-actions"><button className="primary" disabled={busy||(!project&&scope!=='all')} onClick={()=>void run('export')}><Download size={16} aria-hidden="true"/>Export workspace</button>{download&&<a className="transfer-download" href={download} download="wonderworks-workspaces.wwspace">Download archive again</a>}</div>
        <p className="transfer-note">Save any pending edits before exporting.</p>
      </section>
      <section className="transfer-action" aria-labelledby="workspace-import-title">
        <div className="transfer-action-title"><Upload size={19} aria-hidden="true"/><h4 id="workspace-import-title">Import workspace</h4></div>
        <p>Choose a backup to preview its projects before restoring or copying them.</p>
        <label className={'archive-file-picker'+(file?' has-file':'')}><FileArchive size={23} aria-hidden="true"/><span><strong>{file?file.name:'Choose a workspace archive'}</strong><span>{file?`${(file.size/1024/1024).toFixed(2)} MiB · Ready to preview`:'.wwspace file · up to 32 MiB'}</span></span><input aria-label="Workspace archive" type="file" accept=".wwspace" disabled={busy||uncertain} onChange={e=>{setFile(e.target.files?.[0]??null);setPreview(null);setResult([]);operation.current='';setError('');}}/></label>
        <div className="transfer-actions"><button className="secondary" disabled={busy||!file||uncertain} onClick={()=>void run('preview')}>Preview archive</button></div>
        <p className="transfer-note">Existing projects stay intact. You choose what to import.</p>
      </section>
    </div>
    {preview&&<section className="archive-preview" aria-labelledby="archive-preview-title">
      <div className="archive-preview-heading"><div><h4 id="archive-preview-title">Choose projects to import</h4><p>Restore an available ID, create a separate copy, or skip a project.</p></div><span className="settings-badge">{preview.projects.length} {preview.projects.length===1?'project':'projects'}</span></div>
      {!!preview.warnings.length&&<ul className="archive-warnings">{preview.warnings.map(w=><li key={w}>{w}</li>)}</ul>}
      <div className="archive-project-list">{preview.projects.map(p=><article className="archive-project" key={p.id}>
        <div className="archive-project-info"><strong>{p.name}</strong><p>{p.items} items · {p.proposals} proposals · {p.snapshots} snapshots · {p.history_events} history events</p><span className={'archive-conflict'+(p.conflict?' is-conflict':'')}>{p.deleted?'This ID is reserved after deletion. Import a copy or skip.':p.conflict?'This ID already exists. Import a copy or skip.':'This ID is available for exact restore.'}</span><details><summary>Project details</summary><p>{p.id} · workspace v{p.version}</p></details></div>
        <label className="settings-field">Import as<select aria-label={'Import mode for '+p.name} disabled={busy||uncertain} value={modes[p.id]} onChange={e=>{setModes({...modes,[p.id]:e.target.value});operation.current='';}}><option value="skip">Skip</option>{!p.conflict&&<option value="restore">Restore original ID</option>}<option value="copy">Import as a separate copy</option></select></label>
      </article>)}</div>
      <div className="archive-confirm"><span>{Object.values(modes).filter(mode=>mode!=='skip').length} selected</span><button className="primary" disabled={busy||!!result.length||!Object.values(modes).some(mode=>mode!=='skip')} onClick={()=>void run('import')}>{uncertain?'Retry same import':'Confirm selected imports'}</button></div>
      <details className="archive-identity"><summary>Archive details</summary><p>{preview.archive_id}</p></details>
    </section>}
    {(message||error||busy||uncertain||!!result.length)&&<div className="transfer-feedback">
      {message&&<p className="transfer-status" role="status" aria-live="polite">{busy?<LoaderCircle size={18} className="spinning" aria-hidden="true"/>:<CheckCircle2 size={18} aria-hidden="true"/>}<span>{message}</span></p>}
      {error&&<p className="error-box" role="alert">{error}</p>}
      {!!result.length&&<div className="transfer-results">{result.map(p=><button className="secondary" key={p.id} onClick={()=>onOpenProject(p.id)}>Open {p.name}</button>)}</div>}
      {busy&&<button className="secondary" onClick={()=>controller.current?.abort()}>Cancel transfer</button>}
      {!busy&&uncertain&&<button className="secondary" onClick={()=>{setUncertain(false);operation.current='';try{sessionStorage.removeItem(pendingImportKey);}catch{}setPreview(null);setFile(null);setError('Check the project selector for a completed import before starting a new operation.');}}>Inspect projects before starting another import</button>}
    </div>}
    <footer className="transfer-limits"><span><FileArchive size={15} aria-hidden="true"/>Includes saved content and history</span><span>Up to 50 projects · 32 MiB compressed · 64 MiB expanded</span></footer>
  </section>;
}
export function ImportedProvenance({project}:{project:string}){
  const [provenance,setProvenance]=useState<{source_project:string;source_archive:string;imported_at:string;imported_by:string;historical_assertions:string}|null>(null);
  useEffect(()=>{const abort=new AbortController();void fetch('/api/workspace-archive?provenance='+encodeURIComponent(project),{signal:abort.signal,cache:'no-store'}).then(r=>r.ok?r.json():null).then(value=>setProvenance(value as typeof provenance)).catch(()=>{});return()=>abort.abort();},[project]);
  if(!provenance)return null;
  return <aside className="imported-provenance"><strong>Imported workspace</strong><p>{provenance.historical_assertions}</p><details><summary>Source and import event</summary><p>Source project: {provenance.source_project}. Archive: {provenance.source_archive}. Imported {provenance.imported_at} by {provenance.imported_by}.</p></details></aside>;
}
