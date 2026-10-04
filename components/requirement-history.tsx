'use client';
import {useEffect,useRef,useState} from 'react';
import {Clock} from 'lucide-react';
import {Sheet,SheetContent,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {requirementHistory,type Milestone,type RequirementHistoryPage} from '@/lib/requirement-history';
import type {Workspace,Requirement} from '@/lib/types';

const date=(value:string)=>new Date(value).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
const labels:Record<string,string>={section:'Section',title:'Title',description:'Description',criteria:'Acceptance criteria',priority:'Priority',status:'Status',parameters:'Parameters',links:'Dependencies',tags:'Tags'};
const milestones:Record<string,string>={created:'Created',last_changed:'Last changed',last_change_accepted:'Last change accepted',first_approved:'First approved',last_approved:'Most recently approved',last_implemented:'Most recently implemented'};
function DateValue({value}:{value:Milestone}){
  return value.state==='known'?<><time dateTime={value.date!}>{date(value.date!)}</time><small>{value.proposalId&&`${value.proposalId} · `}{value.deleted?'Deletion of ':''}r{value.revision}</small></>:<span className="muted">{value.state==='unknown'?'Unknown · earlier history missing':'Not yet recorded'}</span>;
}
function Lifecycle({lifecycle}:{lifecycle:RequirementHistoryPage['lifecycle']}){
  return <dl className="lifecycle-dates">{Object.entries(lifecycle).map(([key,value])=><div key={key}><dt>{milestones[key]}</dt><dd><DateValue value={value}/></dd></div>)}</dl>;
}
export function RequirementLifecycle({doc,id,onHistory}:{doc:Workspace;id:string;onHistory:()=>void}){
  const data=requirementHistory(doc,id);
  return <section className="requirement-lifecycle" aria-label={'Lifecycle dates for '+id}><h4>LIFECYCLE DATES</h4><Lifecycle lifecycle={data.lifecycle}/><p className="history-note">Dates refer to the recorded revision. Acceptance and lifecycle status are separate.</p><button className="secondary" onClick={onHistory}><Clock size={14}/>History of {id}</button></section>;
}
function Field({requirement,field}:{requirement:Requirement|null;field:string}){
  if(!requirement)return <span className="muted">Not present</span>;
  const value=requirement[field as keyof Requirement];
  if(value===undefined)return <span className="muted">Not recorded</span>;
  if(Array.isArray(value))return value.length?<ul>{value.map((v,i)=><li key={i}>{v}</li>)}</ul>:<span className="muted">None</span>;
  return typeof value==='object'?<pre>{JSON.stringify(value,null,2)}</pre>:<span>{String(value)}</span>;
}
export function RequirementHistory({doc,id,onClose,onSource}:{doc:Workspace;id:string;onClose:()=>void;onSource:(kind:'proposal'|'snapshot',id:string)=>void}){
  const [data,setData]=useState<RequirementHistoryPage|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[restart,setRestart]=useState(false);
  const controller=useRef<AbortController|null>(null),retryCursor=useRef<string|undefined>(undefined);
  async function load(cursor?:string){
    controller.current?.abort();const abort=new AbortController();controller.current=abort;
    retryCursor.current=cursor;setLoading(true);setError('');setRestart(false);
    try{
      const query=new URLSearchParams({project_id:doc.id,requirement_id:id,...(cursor?{cursor}:{})});
      const response=await fetch('/api/requirement-history?'+query,{cache:'no-store',signal:abort.signal});
      const result=await response.json() as RequirementHistoryPage&{error?:{code:string;message:string}};
      if(!response.ok){setRestart(result.error?.code==='RESTART_REQUIRED');throw Error(result.error?.message??'Unable to load history.');}
      if(!abort.signal.aborted)setData(old=>cursor&&old?{...result,items:[...old.items,...result.items]}:result);
    }catch(e){if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Unable to load history.');}
    finally{if(!abort.signal.aborted)setLoading(false);}
  }
  useEffect(()=>{void load();return()=>controller.current?.abort();},[doc.id,id]); // selection is keyed by the caller
  return <Sheet open onOpenChange={open=>{if(!open)onClose();}}><SheetContent className="requirement-history-reader"><SheetTitle>History · {id}</SheetTitle><SheetDescription>{doc.name} · {data?.title??'Requirement change timeline'}</SheetDescription>
    {data&&<><div className="history-identity"><strong>{data.presence==='deleted'?'Deleted requirement':data.presence==='pending'?'Uncommitted requirement':data.presence==='absent'?'Requirement absent from current set':`Current revision ${data.current_revision}`}</strong>{data.current_status&&<span className={'badge '+data.current_status.toLowerCase()}>{data.current_status}</span>}</div><Lifecycle lifecycle={data.lifecycle}/><div className="history-coverage"><strong>{data.coverage.state==='complete'?'Complete history':'Partial legacy history'}</strong><p>{data.coverage.message}</p>{data.coverage.first_observed&&<p>First observed in {data.coverage.first_observed.snapshotId} on {date(data.coverage.first_observed.date)}. This observation does not establish creation or approval.</p>}</div>
    <ol className="requirement-timeline">{data.items.map(event=><li key={event.id}><article><header><strong>{event.kind==='proposed_creation'?'Created in proposal · uncommitted':event.source==='proposal_apply'?'Change accepted':event.kind==='imported'?'Imported change':event.kind==='deleted'?'Direct deletion':event.kind==='created'?'Direct creation':'Direct change'}</strong><time dateTime={event.date}>{date(event.date)}</time></header><p className="history-meta">{event.before?`r${event.before.revision}`:'Not present'} → {event.after?`r${event.after.revision}`:'Deleted'} · Set v{event.beforeSetVersion} → v{event.afterSetVersion}</p><p className="history-meta">Actor: {event.actor.id??'Unknown'} · Source: {event.source}{event.actor.reportedClientName&&<> · Client (reported): {event.actor.reportedClientName}</>}</p>
    {event.committed&&event.source!=='import'&&event.after?.status!==event.before?.status&&event.after&&<p className="history-status">Status: {event.before?.status??'Not present'} → {event.after.status}</p>}
    {event.kind==='proposed_creation'&&<p className="history-note">Initial creation provenance. This event does not commit or accept the proposed revision.</p>}{event.kind==='imported'&&<p className="history-note">Recorded at local import time. Original change and lifecycle dates are unknown.{event.revisionGap?' Intermediate revisions are unavailable.':''}</p>}
    {(event.proposalId||event.snapshotId)&&<div className="history-sources">{event.proposalId&&(event.proposalAvailable?<button className="secondary" onClick={()=>onSource('proposal',event.proposalId!)}>Open {event.proposalId}</button>:<span>{event.proposalId} · Proposal unavailable</span>)}{event.snapshotId&&(event.snapshotAvailable?<button className="secondary" onClick={()=>onSource('snapshot',event.snapshotId!)}>Open {event.snapshotId}</button>:<span>{event.snapshotId} · Snapshot unavailable</span>)}</div>}
    {event.reviewNote&&<blockquote><strong>Review note</strong><p>{event.reviewNote}</p></blockquote>}
    <details><summary>{event.fields.length?`Show ${event.fields.length} changed ${event.fields.length===1?'field':'fields'}`:'Show revision details'}</summary>{event.fields.map(field=><section className="history-field" key={field}><h4>{labels[field]??field}</h4><div className="history-values"><div><h5>Before</h5><Field requirement={event.before} field={field}/></div><div><h5>After</h5><Field requirement={event.after} field={field}/></div></div></section>)}{!event.fields.length&&<p>Imported revision metadata changed; requirement fields are unchanged.</p>}</details></article></li>)}</ol>
    {!data.items.length&&<p className="history-note">No recorded events for this requirement. Known snapshot observations are shown above.</p>}</>}
    {loading&&<p role="status">Loading {data?'older entries':'history'}…</p>}{error&&<div role="alert" className="error-box"><p>{error}</p><button className="secondary" onClick={()=>void load(restart?undefined:retryCursor.current)}>{restart?'Restart history':'Retry history'}</button></div>}
    {data?.next_cursor&&!loading&&!error&&<button className="secondary" onClick={()=>void load(data.next_cursor)}>Load older entries</button>}
  </SheetContent></Sheet>;
}
