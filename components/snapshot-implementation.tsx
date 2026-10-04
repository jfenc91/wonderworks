'use client';
import {useEffect,useRef,useState} from 'react';
import {Copy,ExternalLink,Pencil} from 'lucide-react';
import type {ImplementationCommit,ImplementationCorrection,Workspace} from '@/lib/types';
import {implementationMetadata} from '@/lib/snapshot-implementation';

const date=(value:string)=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'long'});
export function CommitReference({commit}:{commit:ImplementationCommit|null}){
  const [message,setMessage]=useState('');
  if(!commit)return <p>No implementation commit recorded.</p>;
  return <div className="commit-reference"><code>{commit.commit_id}</code><button type="button" className="ghost" aria-label="Copy full commit ID" onClick={async()=>{try{await navigator.clipboard.writeText(commit.commit_id);setMessage('Commit ID copied.');}catch{setMessage('Copy failed. Select the full commit ID to copy it.');}}}><Copy size={14}/>Copy</button>{commit.repository&&<p>Repository: <a href={commit.repository.url} target="_blank" rel="noreferrer">{commit.repository.name}</a><span className="workflow-meta"> · {commit.repository.url}{commit.repository.branch&&` · ${commit.repository.branch}`}</span></p>}{commit.commit_url&&<a className="dependency-link" href={commit.commit_url} target="_blank" rel="noreferrer"><ExternalLink size={14}/>Open commit</a>}{message&&<p role="status">{message}</p>}</div>;
}
type HistoryPage={items:ImplementationCorrection[];next_cursor?:string};
async function fetchCorrections(project:string,id:string,signal:AbortSignal,cursor?:string):Promise<HistoryPage>{
  const response=await fetch('/api/snapshot-implementation?'+new URLSearchParams({project_id:project,baseline_id:id,history:'1',limit:'20',...(cursor?{cursor}:{})}),{cache:'no-store',signal});
  const result=await response.json() as HistoryPage&{error?:{message:string}};
  if(!response.ok)throw Error(result.error?.message??'Unable to read correction history.');
  return result;
}
function CorrectionHistory({doc,id}:{doc:Workspace;id:string}){
  const [page,setPage]=useState<HistoryPage>({items:[]}),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    const request=new AbortController();controller.current=request;
    void fetchCorrections(doc.id,id,request.signal).then(result=>{if(!request.signal.aborted)setPage(result);}).catch(e=>{if(!request.signal.aborted)setError(e instanceof Error?e.message:'Unable to read history.');}).finally(()=>{if(!request.signal.aborted)setLoading(false);});
    return()=>request.abort();
  },[doc.id,id]);
  async function read(cursor?:string){
    const signal=controller.current?.signal;if(!signal)return;
    setLoading(true);setError('');
    try{const result=await fetchCorrections(doc.id,id,signal,cursor);if(!signal.aborted)setPage(previous=>({items:cursor?[...previous.items,...result.items]:result.items,next_cursor:result.next_cursor}));}
    catch(e){if(!signal.aborted)setError(e instanceof Error?e.message:'Unable to read correction history.');}
    finally{if(!signal.aborted)setLoading(false);}
  }
  return <details className="implementation-history"><summary>Commit correction history</summary>{page.items.map(event=><article key={event.id}><p><time dateTime={event.date}>{date(event.date)}</time> · Actor: {event.actor.id??'Unknown'}{event.actor.reportedClientName&&` · Client (reported): ${event.actor.reportedClientName}`}</p><strong>Before</strong><CommitReference commit={event.before}/><strong>After</strong><CommitReference commit={event.after}/></article>)}{!loading&&!error&&!page.items.length&&<p>No recorded corrections.</p>}{loading&&<p role="status">Loading history…</p>}{error&&<p className="error-box" role="alert">{error} <button className="ghost" onClick={()=>void read()}>Restart history</button></p>}{page.next_cursor&&!error&&<button className="secondary" disabled={loading} onClick={()=>void read(page.next_cursor)}>Load older corrections</button>}</details>;
}
export function SnapshotImplementation({doc,id,mutate,busy}:{doc:Workspace;id:string;mutate:(action:string,data?:Record<string,unknown>)=>Promise<Workspace>;busy:boolean}){
  const saved=implementationMetadata(doc,id),commit=saved.implementation_commit;
  const [editing,setEditing]=useState(false),[commitId,setCommitId]=useState(''),[repositoryId,setRepositoryId]=useState(''),[commitUrl,setCommitUrl]=useState(''),[error,setError]=useState('');
  // Retain the original version/key after an uncertain save, including a failed refresh.
  const pending=useRef<{content:string;args:Record<string,unknown>}|null>(null);
  function edit(){setCommitId(commit?.commit_id??'');setRepositoryId(commit?.repository_id??'');setCommitUrl(commit?.commit_url??'');setError('');pending.current=null;setEditing(true);}
  async function save(clear=false){
    setError('');
    const implementation_commit=clear?null:{commit_id:commitId,...(repositoryId?{repository_id:repositoryId}:{}),...(commitUrl.trim()?{commit_url:commitUrl}:{})};
    const content=JSON.stringify(implementation_commit);
    if(pending.current?.content!==content)pending.current={content,args:{project_id:doc.id,baseline_id:id,implementation_commit,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID()}};
    try{await mutate('set_snapshot_implementation',pending.current.args);pending.current=null;setEditing(false);}
    catch(e){setError(e instanceof Error?e.message:'Unable to save implementation commit.');}
  }
  return <section className="snapshot-implementation"><h3>Implementation commit</h3><p className="workflow-footnote">User-recorded reference. This does not mark requirements Implemented or establish passing verification.</p><CommitReference commit={commit}/>{saved.implementation_updated_at&&<p className="workflow-meta">Metadata updated <time dateTime={saved.implementation_updated_at}>{date(saved.implementation_updated_at)}</time> · Actor: {saved.implementation_actor?.id??'Unknown'}</p>}
    {!editing?<button className="secondary" disabled={busy} onClick={edit}><Pencil size={14}/>{commit?'Edit implementation commit':'Add implementation commit'}</button>:<form className="editor-form" onSubmit={e=>{e.preventDefault();void save();}}>
      <label>Full Git commit ID<input required value={commitId} onChange={e=>setCommitId(e.target.value)} spellCheck={false}/><span className="field-hint">40 or 64 hexadecimal characters</span></label>
      <label>Repository (optional)<select value={repositoryId} onChange={e=>setRepositoryId(e.target.value)}><option value="">No repository association</option>{commit?.repository&&!doc.repositories?.some(r=>r.id===commit.repository_id)&&<option value={commit.repository_id}>{commit.repository.name} (unlinked, recorded reference)</option>}{doc.repositories?.map(r=><option value={r.id} key={r.id}>{r.name}</option>)}</select></label>
      <label>Commit URL (optional)<input value={commitUrl} onChange={e=>setCommitUrl(e.target.value)} placeholder="https://…"/><span className="field-hint">Absolute HTTPS URL without credentials</span></label>
      {error&&<p className="error-box" role="alert">{error}</p>}
      <div className="editor-actions"><button className="ghost" type="button" disabled={busy} onClick={()=>{setEditing(false);setError('');pending.current=null;}}>Cancel</button>{commit&&<button className="ghost" type="button" disabled={busy} onClick={()=>void save(true)}>Clear reference</button>}<button className="primary" disabled={busy}>{busy?'Saving…':'Save commit reference'}</button></div>
      {error&&<button className="ghost" type="button" disabled={busy} onClick={async()=>{try{await mutate('reload_workspace');pending.current=null;setError('Latest workspace loaded. Review your input and save again.');}catch(e){setError(e instanceof Error?e.message:'Unable to reload.');}}}>Reload latest; keep input</button>}
    </form>}
    <CorrectionHistory key={doc.id+id+doc.version} doc={doc} id={id}/>
  </section>;
}
