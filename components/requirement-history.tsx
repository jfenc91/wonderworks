'use client';
import {normative} from '@/lib/item-content';
import {RichContent} from './rich-content';
import {useState} from 'react';
import {Clock} from 'lucide-react';
import {Sheet,SheetContent,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {requirementHistory,type Milestone,type RequirementHistoryPage} from '@/lib/requirement-history';
import type {Workspace,Requirement} from '@/lib/types';

const date=(value:string)=>new Date(value).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
const labels:Record<string,string>={section:'Section',title:'Title',description:'Description',criteria:'Acceptance criteria',priority:'Priority',status:'Status',parameters:'Parameters',links:'Dependencies',tags:'Tags'};
const milestones:Record<string,string>={created:'Created',last_changed:'Last changed',last_change_accepted:'Last change accepted',first_approved:'First approved',first_known_approved:'First known approval',last_approved:'Most recently approved',last_implemented:'Most recently implemented'};
function DateValue({value}:{value:Milestone}){
  return value.state==='known'?<><time dateTime={value.date!}>{date(value.date!)}</time><small>{value.proposalId&&`${value.proposalId} · `}{value.deleted?'Deletion of ':''}r{value.revision}</small></>:<span className="muted">{value.state==='unknown'?'Unknown · earlier history missing':'Not yet recorded'}</span>;
}
function Lifecycle({lifecycle,information=false}:{lifecycle:RequirementHistoryPage['lifecycle'];information?:boolean}){
  return <dl className="lifecycle-dates">{Object.entries(lifecycle).filter(([key])=>(!information||key!=='last_implemented')&&(key!=='first_known_approved'||lifecycle.first_approved.state!=='known')).map(([key,value])=><div key={key}><dt>{information&&(key.includes('approved')||key==='first_known_approved')?'Editorial '+milestones[key].toLowerCase():milestones[key]}</dt><dd><DateValue value={value}/></dd></div>)}</dl>;
}
export function RequirementLifecycle({doc,id,onHistory}:{doc:Workspace;id:string;onHistory:()=>void}){
  const data=requirementHistory(doc,id),item=doc.requirements.find(r=>r.id===id)??doc.proposals?.flatMap(p=>p.requirements).find(r=>r.id===id),information=!!item&&!normative(item);
  return <section className="requirement-lifecycle" aria-label={'Lifecycle dates for '+id}><h4>LIFECYCLE DATES</h4><Lifecycle lifecycle={data.lifecycle} information={information}/><p className="history-note">Dates refer to the recorded revision. Apply approves each accepted revision; matching snapshot commits implement it. Verification remains separate.</p><button className="secondary" onClick={onHistory}><Clock size={14}/>History of {id}</button></section>;
}
function Field({requirement,field}:{requirement:Requirement|null;field:string}){
  if(!requirement)return <span className="muted">Not present</span>;
  const value=requirement[field as keyof Requirement];
  if(value===undefined)return <span className="muted">Not recorded</span>;
  if(Array.isArray(value))return value.length?<ul>{value.map((v,i)=><li key={i}>{typeof v==='object'?<pre>{JSON.stringify(v,null,2)}</pre>:v}</li>)}</ul>:<span className="muted">None</span>;
  return typeof value==='object'?<pre>{JSON.stringify(value,null,2)}</pre>:<pre>{String(value)}</pre>;
}
export function RequirementHistory({doc,id,onClose,onSource}:{doc:Workspace;id:string;onClose:()=>void;onSource:(kind:'proposal'|'snapshot',id:string)=>void}){
  const [shown,setShown]=useState(50);
  // The workspace already contains durable history. Derive all open views from
  // this same committed revision, preserving the reader and its scroll/focus.
  const history=requirementHistory(doc,id),item=doc.requirements.find(r=>r.id===id)??doc.proposals?.flatMap(p=>p.requirements).find(r=>r.id===id),information=!!item&&!normative(item);
  const data={...history,items:history.items.slice(0,shown)};
  return <Sheet open onOpenChange={open=>{if(!open)onClose();}}><SheetContent className="requirement-history-reader"><SheetTitle>History · {id}</SheetTitle><SheetDescription>{doc.name} · {data?.title??'Requirement change timeline'}</SheetDescription>
    {data&&<><div className="history-identity"><strong>{data.presence==='deleted'?'Deleted requirement':data.presence==='pending'?'Uncommitted requirement':data.presence==='absent'?'Requirement absent from current set':`Current revision ${data.current_revision}`}</strong>{data.current_status&&<span className={'badge '+data.current_status.toLowerCase()}>{information?'Editorial: ':''}{data.current_status}</span>}</div><Lifecycle lifecycle={data.lifecycle} information={information}/><div className="history-coverage"><strong>{data.coverage.state==='complete'?'Complete history':'Partial legacy history'}</strong><p>{data.coverage.message}</p>{data.coverage.first_observed&&<p>First observed in {data.coverage.first_observed.snapshotId} on {date(data.coverage.first_observed.date)}. This observation does not establish creation or approval.</p>}</div>
    <ol className="requirement-timeline">{data.items.map(event=><li key={event.id}><article><header><strong>{event.kind==='reconciled'?'Recovered lifecycle record':event.kind==='lifecycle'?'Lifecycle metadata changed':event.kind==='proposed_creation'?'Created in proposal · uncommitted':event.source==='proposal_apply'?'Change accepted':event.kind==='imported'?'Imported change':event.kind==='deleted'?'Direct deletion':event.kind==='created'?'Direct creation':'Direct change'}</strong><time dateTime={event.date}>{date(event.date)}</time></header><p className="history-meta">{event.before?`r${event.before.revision}`:'Not present'} → {event.after?`r${event.after.revision}`:'Deleted'} · Set v{event.beforeSetVersion} → v{event.afterSetVersion}</p><p className="history-meta">Actor: {event.actor.id??'Unknown'} · Source: {event.source}{event.actor.reportedClientName&&<> · Client (reported): {event.actor.reportedClientName}</>}</p>
    {event.committed&&event.source!=='import'&&event.after?.status!==event.before?.status&&event.after&&<p className="history-status">Status: {event.before?.status??'Not present'} → {event.after.status}</p>}
    {event.kind==='proposed_creation'&&<p className="history-note">Initial creation provenance. This event does not commit or accept the proposed revision.</p>}{event.kind==='imported'&&<p className="history-note">Recorded at local import time. Original change and lifecycle dates are unknown.{event.revisionGap?' Intermediate revisions are unavailable.':''}</p>}
    {(event.proposalId||event.snapshotId)&&<div className="history-sources">{event.proposalId&&(event.proposalAvailable?<button className="secondary" onClick={()=>onSource('proposal',event.proposalId!)}>Open {event.proposalId}</button>:<span>{event.proposalId} · Proposal unavailable</span>)}{event.snapshotId&&(event.snapshotAvailable?<button className="secondary" onClick={()=>onSource('snapshot',event.snapshotId!)}>Open {event.snapshotId}</button>:<span>{event.snapshotId} · Snapshot unavailable</span>)}</div>}
    {event.lifecycle&&<div className="history-note"><p>{event.lifecycle.reason}</p>{event.lifecycle.approval&&<p>Approval recorded for r{event.after?.revision}.</p>}{event.lifecycle.commitId&&<p>Trigger commit: <code>{event.lifecycle.commitId}</code></p>}{event.lifecycle.recovered&&<p>Reconciled at {date(event.date)}. Historical approval: {event.lifecycle.approvalDate?date(event.lifecycle.approvalDate):'Unknown'}. Historical implementation: {event.lifecycle.implementationDate?date(event.lifecycle.implementationDate):'Unknown'}.</p>}{event.lifecycle.supports.map(s=><p key={s.baseline_id}>{s.baseline_id}: <code>{s.commit.commit_id}</code></p>)}</div>}{event.reviewNote&&<blockquote><strong>Review note</strong><p>{event.reviewNote}</p></blockquote>}
    <details><summary>Rendered before and after</summary><div className="rendered-comparison"><div><h5>Before</h5>{event.before&&<RichContent item={event.before}/>}</div><div><h5>After</h5>{event.after&&<RichContent item={event.after}/>}</div></div></details><details><summary>{event.fields.length?`Show ${event.fields.length} changed ${event.fields.length===1?'field':'fields'}`:'Show revision details'}</summary>{event.fields.map(field=><section className="history-field" key={field}><h4>{labels[field]??field}</h4><div className="history-values"><div><h5>Before</h5><Field requirement={event.before} field={field}/></div><div><h5>After</h5><Field requirement={event.after} field={field}/></div></div></section>)}{!event.fields.length&&<p>Recorded metadata changed; authored requirement fields are unchanged.</p>}</details></article></li>)}</ol>
    {!data.items.length&&<p className="history-note">No recorded events for this requirement. Known snapshot observations are shown above.</p>}</>}
    {history.items.length>shown&&<button className="secondary" onClick={()=>setShown(count=>count+50)}>Load older entries</button>}
  </SheetContent></Sheet>;
}
