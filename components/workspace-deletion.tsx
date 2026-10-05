'use client';
import {useRef,useState} from 'react';
import {Trash2} from 'lucide-react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from './ui/dialog';
import {validateArchiveDownload} from '@/lib/archive-download.mjs';
import {recoverFormInput} from '@/lib/pending-input';
import type {Workspace} from '@/lib/types';

export function WorkspaceDeletion({doc,disabled,onDeleted}:{doc:Workspace;disabled:boolean;onDeleted:()=>void}){
  const [base,setBase]=useState<Workspace|null>(null),[name,setName]=useState(''),[discard,setDiscard]=useState(false),[hasInput,setHasInput]=useState(false),[busy,setBusy]=useState(false),[exporting,setExporting]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false);
  const key=useRef(''),cancel=useRef<HTMLButtonElement>(null);
  const stale=!!base&&(base.id!==doc.id||base.version!==doc.version);
  function open(){setHasInput(!!recoverFormInput());setBase(doc);setName('');setDiscard(false);setError('');setMessage('');setUncertain(false);key.current=crypto.randomUUID();}
  async function exportFirst(){
    setExporting(true);setError('');setMessage('Preparing complete workspace archive…');
    try{const r=await fetch('/api/workspace-archive?scope='+encodeURIComponent(doc.id),{cache:'no-store'});if(!r.ok)throw Error('Export failed. You can retry the export or cancel deletion.');const blob=await r.blob();await validateArchiveDownload(blob);const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=doc.name+'.wwspace';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage('Workspace archive downloaded. Deletion still requires your confirmation.');}
    catch(e){setError(e instanceof Error?e.message:'Export failed.');setMessage('');}finally{setExporting(false);}
  }
  async function remove(){
    if(!base||busy||exporting||disabled||(!uncertain&&(stale||name!==base.name||hasInput&&!discard)))return;
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/workspace-deletion',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:base.id,expected_workspace_version:base.version,idempotency_key:key.current})});
      const result=await response.json() as {deleted?:boolean;project_id?:string;error?:string};
      if(!response.ok){setUncertain(response.status>=500);throw Error(result.error??'Deletion failed.');}
      if(!result.deleted||result.project_id!==base.id)throw Error('Deletion outcome is uncertain. Retry the same request.');
      setBase(null);onDeleted();
    }catch(e){if(!(e instanceof Error))setError('Deletion outcome is uncertain. Retry the same request.');else setError(e.message);if(e instanceof TypeError||e instanceof SyntaxError)setUncertain(true);}
    finally{setBusy(false);}
  }
  return <section className="settings-card deletion-settings" aria-labelledby="deletion-settings-title"><header className="settings-card-header"><span className="settings-icon"><Trash2 size={21}/></span><div><h3 id="deletion-settings-title">Delete workspace</h3><p>Permanently remove this project and its saved history.</p></div><button className="secondary destructive" disabled={disabled} onClick={open}>Delete workspace</button></header>
    <Dialog open={!!base} onOpenChange={value=>{if(!value&&!busy&&!uncertain)setBase(null);}}><DialogContent className="workspace-delete-dialog" data-workspace-deletion onOpenAutoFocus={event=>{event.preventDefault();cancel.current?.focus();}}><DialogTitle>Delete {base?.name}?</DialogTitle><DialogDescription>This permanently deletes the complete workspace. There is no in-app undo.</DialogDescription>
      <p><strong>{base?.name}</strong> · {base?.prefix}<br/><span className="field-hint">Project ID: {base?.id}</span></p>
      <p>Requirements, Information, sections, proposals, snapshots, evidence, history, AI guidance, repository associations, and implementation records will be removed. External repositories, downloaded archives, and independent backups remain available.</p>
      <button className="secondary" disabled={busy||exporting||uncertain} onClick={()=>void exportFirst()}>{exporting?'Exporting…':'Export workspace first'}</button>
      {hasInput&&<p className="error-box">This browser has open form input. Unsaved input is not included in the archive.</p>}
      <form className="editor-form" onSubmit={e=>{e.preventDefault();void remove();}}>
        {hasInput&&<label className="deletion-discard"><input type="checkbox" checked={discard} disabled={busy||uncertain} onChange={e=>setDiscard(e.target.checked)}/>Discard this workspace’s unsaved input when deletion succeeds</label>}
        <label>Enter the project name to confirm<input aria-label="Project name to confirm deletion" value={name} onChange={e=>setName(e.target.value)} disabled={busy||uncertain} autoComplete="off"/></label>
        {stale&&!uncertain&&<div className="error-box" role="alert">The workspace changed. Review the current saved contents before confirming again. <button className="secondary" type="button" onClick={()=>{setBase(null);}}>Cancel and review workspace</button></div>}
        {message&&<p role="status">{message}</p>}{error&&<p className="error-box" role="alert">{error}</p>}
        {uncertain&&<p role="status">The result is uncertain. Retrying uses the same project, confirmed version, and request key.</p>}
        <div className="editor-actions"><button ref={cancel} type="button" className="ghost" disabled={busy} onClick={()=>setBase(null)}>Cancel</button><button className="primary destructive" disabled={disabled||busy||exporting||(!uncertain&&(stale||name!==base?.name||hasInput&&!discard))}>{busy?'Deleting…':uncertain?'Retry same deletion':'Delete workspace'}</button></div>
      </form>
    </DialogContent></Dialog>
  </section>;
}
