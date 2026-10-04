'use client';
import {useRef,useState} from 'react';
import {EditConflict,useEditBase,editBlocked} from '@/components/edit-conflict';
import {Copy,ExternalLink,Pencil} from 'lucide-react';
import type {ImplementationCommit,Workspace} from '@/lib/types';
import {implementationMetadata} from '@/lib/snapshot-implementation';

const isUncertain=(error:unknown)=>!(error instanceof Error&&'status' in error&&Number(error.status)>=400&&Number(error.status)<500);
const date=(value:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'});
export function CommitReference({commit}:{commit:ImplementationCommit|null}){
  const [message,setMessage]=useState('');
  if(!commit)return <p>No implementation commit recorded.</p>;
  return <div className="commit-reference"><code>{commit.commit_id}</code><button type="button" className="ghost" aria-label="Copy full commit ID" onClick={async()=>{try{await navigator.clipboard.writeText(commit.commit_id);setMessage('Commit ID copied.');}catch{setMessage('Copy failed. Select the full commit ID to copy it.');}}}><Copy size={14}/>Copy</button>{commit.repository&&<p>Repository: <a href={commit.repository.url} target="_blank" rel="noreferrer">{commit.repository.name}</a><span className="workflow-meta"> · {commit.repository.url}{commit.repository.branch&&` · ${commit.repository.branch}`}</span></p>}{commit.commit_url&&<a className="dependency-link" href={commit.commit_url} target="_blank" rel="noreferrer"><ExternalLink size={14}/>Open commit</a>}{message&&<p role="status">{message}</p>}</div>;
}
function CorrectionHistory({doc,id}:{doc:Workspace;id:string}){
  const [shown,setShown]=useState(20);
  const items=[...(doc.snapshotImplementations?.[id]?.history??[])].reverse();
  return <details className="implementation-history"><summary>Commit correction history</summary>{items.slice(0,shown).map(event=><article key={event.id}><p><time dateTime={event.date}>{date(event.date)}</time> · Actor: {event.actor.id??'Unknown'}{event.actor.reportedClientName&&` · Client (reported): ${event.actor.reportedClientName}`}</p><strong>Before</strong><CommitReference commit={event.before}/><strong>After</strong><CommitReference commit={event.after}/></article>)}{!items.length&&<p>No recorded corrections.</p>}{items.length>shown&&<button className="secondary" onClick={()=>setShown(count=>count+20)}>Load older corrections</button>}</details>;
}
export function SnapshotImplementation({doc,id,mutate,busy}:{doc:Workspace;id:string;mutate:(action:string,data?:Record<string,unknown>,base?:Workspace|null)=>Promise<Workspace>;busy:boolean}){
  const editBase=useEditBase();
  const saved=implementationMetadata(doc,id),commit=saved.implementation_commit;
  const [editing,setEditing]=useState(false),[commitId,setCommitId]=useState(''),[repositoryId,setRepositoryId]=useState(''),[commitUrl,setCommitUrl]=useState(''),[error,setError]=useState('');
  // Retain the original version/key after an uncertain save, including a failed refresh.
  const pending=useRef<{content:string;args:Record<string,unknown>}|null>(null);
  const [uncertain,setUncertain]=useState(false);
  function edit(){editBase.setBase(doc);setCommitId(commit?.commit_id??'');setRepositoryId(commit?.repository_id??'');setCommitUrl(commit?.commit_url??'');setError('');setUncertain(false);pending.current=null;setEditing(true);}
  async function save(clear=false){
    setError('');
    const implementation_commit=clear?null:{commit_id:commitId,...(repositoryId?{repository_id:repositoryId}:{}),...(commitUrl.trim()?{commit_url:commitUrl}:{})};
    const content=JSON.stringify(implementation_commit);
    if(pending.current?.content!==content)pending.current={content,args:{project_id:doc.id,baseline_id:id,implementation_commit,expected_workspace_version:editBase.base?.version,idempotency_key:crypto.randomUUID()}};
    try{await mutate('set_snapshot_implementation',pending.current.args);pending.current=null;setEditing(false);}
    catch(e){setUncertain(isUncertain(e));setError(e instanceof Error?e.message:'Unable to save implementation commit.');}
  }
  return <section className="snapshot-implementation"><h3>Implementation commit</h3><p className="workflow-footnote">User-recorded reference. This does not mark requirements Implemented or establish passing verification.</p><CommitReference commit={commit}/>{saved.implementation_updated_at&&<p className="workflow-meta">Metadata updated <time dateTime={saved.implementation_updated_at}>{date(saved.implementation_updated_at)}</time> · Actor: {saved.implementation_actor?.id??'Unknown'}</p>}
    {!editing?<button className="secondary" disabled={busy} onClick={edit}><Pencil size={14}/>{commit?'Edit implementation commit':'Add implementation commit'}</button>:<form className="editor-form" onSubmit={e=>{e.preventDefault();void save();}}>
      <EditConflict base={editBase.base} doc={doc} latest={commit} onReconcile={()=>{editBase.setBase(doc);pending.current=null;}}/><label>Full Git commit ID<input required value={commitId} onChange={e=>setCommitId(e.target.value)} spellCheck={false}/><span className="field-hint">40 or 64 hexadecimal characters</span></label>
      <label>Repository (optional)<select value={repositoryId} onChange={e=>setRepositoryId(e.target.value)}><option value="">No repository association</option>{commit?.repository&&!doc.repositories?.some(r=>r.id===commit.repository_id)&&<option value={commit.repository_id}>{commit.repository.name} (unlinked, recorded reference)</option>}{doc.repositories?.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
      <label>Commit URL (optional)<input value={commitUrl} onChange={e=>setCommitUrl(e.target.value)} placeholder="https://…"/><span className="field-hint">Absolute HTTPS URL without credentials</span></label>
      {error&&<p className="error-box" role="alert">{error}</p>}
      {uncertain&&pending.current&&<button className="secondary" type="button" disabled={busy} onClick={async()=>{
        try{await mutate('set_snapshot_implementation',pending.current!.args);pending.current=null;setUncertain(false);setError('Original save confirmed. Inspect the saved reference and reconcile any remaining input before continuing.');}
        catch(e){setUncertain(isUncertain(e));setError(e instanceof Error?e.message:'Unable to confirm the original save.');}
      }}>Retry original save</button>}
      <div className="editor-actions"><button className="ghost" type="button" disabled={busy} onClick={()=>{setEditing(false);setError('');pending.current=null;}}>Cancel</button>{commit&&<button className="ghost" type="button" disabled={busy||editBlocked(editBase.base,doc)} onClick={()=>void save(true)}>Clear reference</button>}<button className="primary" disabled={busy||editBlocked(editBase.base,doc)}>{busy?'Saving…':'Save commit reference'}</button></div>
      {error&&<button className="ghost" type="button" disabled={busy} onClick={async()=>{try{await mutate('reload_workspace');setError('Latest workspace loaded. Inspect it and explicitly reconcile before saving.');}catch(e){setError(e instanceof Error?e.message:'Unable to reload.');}}}>Reload latest; keep input</button>}
    </form>}
    <CorrectionHistory key={doc.id+id} doc={doc} id={id}/>
  </section>;
}
