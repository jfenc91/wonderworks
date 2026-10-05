'use client';
import {useState} from 'react';
import {Sparkles} from 'lucide-react';
import {WorkspaceTransfer} from './workspace-transfer';
export function WorkspaceEmpty({projects,message,recovery,onDiscard,onOpen}:{projects:{id:string;name:string}[];message:string;recovery:string;onDiscard:()=>void;onOpen:(id:string)=>void}){
  const [creating,setCreating]=useState(false),[name,setName]=useState(''),[prefix,setPrefix]=useState('REQ'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function create(event:React.FormEvent){event.preventDefault();setBusy(true);setError('');try{const response=await fetch('/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'project',name,prefix})});const data=await response.json() as {id:string;error?:string};if(!response.ok)throw Error(data.error??'Unable to create project.');onOpen(data.id);}catch(e){setError(e instanceof Error?e.message:'Unable to create project.');}finally{setBusy(false);}}
  return <main className="workspace-empty"><Sparkles size={40}/><h1>Wonderworks</h1><h2>{projects.length?'Choose a workspace':'No workspaces yet'}</h2><p role="status">{message}</p>
    {!!recovery&&<section className="settings-card recovery-card"><h3>Recover unsaved input</h3><p>The original workspace is unavailable. Copy this input before discarding it. It will not be saved to another project automatically.</p><textarea aria-label="Recovered unsaved input" rows={10} readOnly value={recovery}/><button className="secondary" onClick={onDiscard}>Discard recovered input</button></section>}
    <fieldset disabled={!!recovery} className="workspace-empty-actions">{!!projects.length&&<label>Open project<select aria-label="Current project" value="" onChange={e=>onOpen(e.target.value)}><option value="" disabled>Select a project</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
    <button className="primary" onClick={()=>setCreating(true)}>Create project</button>
    {creating&&<form className="editor-form settings-card" onSubmit={create}><h3>New project</h3><label>Project name<input required minLength={2} maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label><label>Requirement prefix<input required pattern="[A-Z]{2,6}" maxLength={6} value={prefix} onChange={e=>setPrefix(e.target.value.toUpperCase())}/></label>{error&&<p role="alert" className="error-box">{error}</p>}<div className="editor-actions"><button type="button" className="ghost" onClick={()=>setCreating(false)}>Cancel</button><button className="primary" disabled={busy}>{busy?'Creating…':'Save project'}</button></div></form>}
    <WorkspaceTransfer project="" onOpenProject={onOpen}/></fieldset>
  </main>;
}
