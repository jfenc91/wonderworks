'use client';
import {History} from 'lucide-react';
import {useRef,useState,useMemo} from 'react';
import type {Workspace,Requirement} from '@/lib/types';
import {lifecycleState,reconcileLifecycle} from '@/lib/lifecycle';
import {CommitReference} from './snapshot-implementation';
export function LifecycleSupport({doc,item,onSource}:{doc:Workspace;item:Requirement;onSource?:(kind:'proposal'|'snapshot',id:string)=>void}){
 const state=lifecycleState(doc,item);if(item.kind==='information')return null;
 return <section className="lifecycle-support"><h4>Current accepted lifecycle · r{item.revision} · {item.status}</h4>{state.acceptance?<p>Accepted in <button className="dependency-link" onClick={()=>onSource?.('proposal',state.acceptance!.proposal_id)}>{state.acceptance.proposal_id}</button> · <button className="dependency-link" onClick={()=>onSource?.('snapshot',state.acceptance!.snapshot_id)}>{state.acceptance.snapshot_id}</button>{state.acceptance.recovered?' · Recovered record':''}</p>:null}{state.supports.map(s=><div key={s.baseline_id}><button className="dependency-link" onClick={()=>onSource?.('snapshot',s.baseline_id)}>Supporting snapshot {s.baseline_id}</button><CommitReference commit={s.commit}/></div>)}{state.missing_provenance.map(message=><p className="history-note" key={message}>{message}</p>)}{!state.supports.length&&<p className="history-note">An older snapshot supports this revision only if ID, revision and authored content match exactly.</p>}<p className="history-note">{state.assertion}</p></section>;
}
export function LifecycleReconciliation({doc,busy,mutate}:{doc:Workspace;busy:boolean;mutate:(action:string,data:Record<string,unknown>,base?:Workspace|null)=>Promise<Workspace>}){
 const pending=useRef<Record<string,unknown>|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[uncertain,setUncertain]=useState(false);
 const preview=useMemo(()=>{const copy=structuredClone(doc),result=reconcileLifecycle(copy);return {...result,transitions:copy.requirements.filter(r=>r.status!==doc.requirements.find(v=>v.id===r.id)?.status)};},[doc]);
 async function run(retry=false){
  if(!retry)pending.current={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID()};
  setError('');setMessage('');
  try{await mutate('reconcile_lifecycle',pending.current!,doc);pending.current=null;setUncertain(false);setMessage('Lifecycle reconciled. Unproven legacy statuses are preserved and flagged for review.');}
  catch(e){const status=(e as {status?:number}).status;setUncertain(status===undefined||status>=500);if(status!==undefined&&status<500)pending.current=null;setError((e as Error).message);}
 }
 return <section className="settings-card workflow-panel reconciliation-panel" aria-labelledby="lifecycle-settings-title"><header className="settings-card-header"><span className="settings-icon"><History size={21} aria-hidden="true"/></span><div><h3 id="lifecycle-settings-title">Lifecycle reconciliation</h3><p>Recover approval and implementation links from saved project records.</p></div><span className="settings-badge">{preview.changed?'Updates available':'Up to date'}</span></header><div className="reconciliation-body"><p>{preview.transitions.length} status transitions · {preview.changed?'Provenance updates available':'Saved lifecycle is up to date'}</p><p className="field-hint">Unknown historical facts stay unknown. Changes are made only when you reconcile.</p>{preview.transitions.length>0&&<details><summary>Preview status changes</summary><ul>{preview.transitions.map(r=><li key={r.id}>{r.id} r{r.revision}: {doc.requirements.find(v=>v.id===r.id)?.status} → {r.status}</li>)}</ul></details>}<button className="secondary" disabled={busy||uncertain||!preview.changed} onClick={()=>void run()}>Reconcile lifecycle from saved records</button>{uncertain&&<button className="secondary" disabled={busy} onClick={()=>void run(true)}>Retry original reconciliation</button>}{error&&<p role="alert" className="error-box">{error}</p>}{message&&<p role="status">{message}</p>}</div></section>;
}
