import type {Workspace,Requirement,RequirementEvent,HistoryActor} from './types';
import {canonical,requirementFields,sameRequirement,setVersion} from './workflow';
import {tagsOf} from './tags';
import {currentRecord} from './lifecycle';
import {normative} from './item-content';
import {ToolError} from './mcp/errors';

export type HistoryContext={source:string;actor:HistoryActor;date?:string};

// Called once at each server mutation boundary, before its atomic workspace save.
// Only server-observed state participates. Imports cannot replace local records.
export function captureRequirementHistory(before:Workspace,doc:Workspace,context:HistoryContext){
  const records=structuredClone(before.requirementHistory??{});
  const date=context.date??new Date().toISOString(),affected=new Set<string>();
  const priorIds=new Set([...before.requirements,...before.baselines.flatMap(b=>b.requirements),...(before.proposals??[]).flatMap(p=>[...p.baseRequirements,...p.requirements])].map(r=>r.id));
  const append=(old:Requirement|null,next:Requirement|null,extra:Pick<RequirementEvent,'kind'|'committed'>&Partial<RequirementEvent>)=>{
    const id=(next??old)!.id;
    const record=records[id]??={complete:!priorIds.has(id)&&context.source!=='import',events:[]};
    if(context.source==='import')record.complete=false;
    const fields=requirementFields.filter(f=>canonical(f==='tags'&&old?tagsOf(old):old?.[f])!==canonical(f==='tags'&&next?tagsOf(next):next?.[f]));
    record.events.push({id:crypto.randomUUID(),projectId:doc.id,requirementId:id,sequence:record.events.length+1,date,
      source:context.source,actor:structuredClone(context.actor),before:structuredClone(old),after:structuredClone(next),fields,
      beforeSetVersion:setVersion(before),afterSetVersion:setVersion(doc),...extra});
    affected.add(id);
  };
  // The first successful save of a new staged identity is its creation, not
  // the proposal's creation time. Keep it even if the addition is later removed.
  for(const proposal of doc.proposals??[])for(const r of proposal.requirements){
    if(!priorIds.has(r.id)&&!records[r.id])append(null,r,{kind:'proposed_creation',committed:false,proposalId:proposal.id});
  }
  const applied=(doc.proposals??[]).find(p=>p.status==='Applied'&&before.proposals?.find(old=>old.id===p.id)?.status!=='Applied');
  for(const id of new Set([...before.requirements,...doc.requirements].map(r=>r.id))){
    const old=before.requirements.find(r=>r.id===id)??null,next=doc.requirements.find(r=>r.id===id)??null;
    const authoredChanged=!sameRequirement(old??undefined,next??undefined)||old?.revision!==next?.revision;
    const oldLife=old?currentRecord(before,old):undefined,nextLife=next?currentRecord(doc,next):undefined;
    const metadataChanged=canonical(oldLife)!==canonical(nextLife);
    if(!authoredChanged&&old?.status===next?.status&&!metadataChanged)continue;
    const recovered=context.source==='reconcile_lifecycle';
    const approval=!!next&&normative(next)&&(!!applied&&authoredChanged||recovered&&!!nextLife?.acceptance&&!oldLife?.acceptance);
    const implementation=!!next&&normative(next)&&next.status==='Implemented'&&(old?.status!=='Implemented'||recovered&&!!nextLife?.supports.length&&!oldLife?.supports.length);
    const correction=Object.values(doc.snapshotImplementations??{}).flatMap(v=>v.history).find(v=>!Object.values(before.snapshotImplementations??{}).some(b=>b.history.some(e=>e.id===v.id)));
    const life=approval||metadataChanged||context.source==='set_snapshot_implementation'||recovered?{approval,implementation,reason:recovered?'Reconciled from saved records':applied?(next?(normative(next)?'Accepted revision approved':'Editorial change accepted'):'Accepted deletion'):next?.status==='Approved'&&old?.status==='Implemented'?'Lost last supporting implementation reference':'Implementation support updated',supports:nextLife?.supports??[],previousSupports:oldLife?.supports??[],...(recovered?{recovered:true,approvalDate:nextLife?.acceptance?.date??null,implementationDate:nextLife?.supports.map(v=>v.recorded_at).filter((v):v is string=>!!v).sort()[0]??null}:{}),...(correction?.after?.commit_id||correction?.before?.commit_id?{commitId:correction.after?.commit_id??correction.before!.commit_id}:{})}:undefined;
    const imported=context.source==='import';
    append(old,next,{kind:imported?'imported':recovered?'reconciled':!authoredChanged?'lifecycle':!old?'created':!next?'deleted':'changed',committed:true,
      ...(life?{lifecycle:life}:{}),...(correction?{snapshotId:correction.baseline_id}:{}),...(recovered&&nextLife?.acceptance?{proposalId:nextLife.acceptance.proposal_id,snapshotId:nextLife.acceptance.snapshot_id}:{}),
      ...(imported?{revisionGap:!old||!!next&&next.revision>old.revision+1}:{}),
      ...(applied?{proposalId:applied.id,snapshotId:applied.appliedSnapshot,reviewNote:applied.reviewNote,source:'proposal_apply'}:{})});
  }
  if(Object.keys(records).length)doc.requirementHistory=records;
  else delete doc.requirementHistory;
  // Reference actual saved identities, never parse free-text legacy messages.
  const oldActivity=new Set(before.history.map(h=>h.id));
  for(const entry of doc.history)if(!oldActivity.has(entry.id)&&affected.size&&!entry.requirementIds?.length){entry.projectId=doc.id;entry.requirementIds=[...affected];}
}

export type Milestone={state:'known'|'unknown'|'not_recorded';date:string|null;revision:number|null;eventId:string|null;proposalId?:string;snapshotId?:string;deleted?:boolean};
function milestone(event:RequirementEvent|undefined,complete:boolean,kind?:'approval'|'implementation'|'acceptance'):Milestone{
  const recoveredDate=kind==='implementation'?event?.lifecycle?.implementationDate:event?.lifecycle?.approvalDate;
  if(event?.lifecycle?.recovered)return {state:recoveredDate?'known':'unknown',date:recoveredDate??null,revision:event.after?.revision??event.before?.revision??null,eventId:event.id,...(event.proposalId?{proposalId:event.proposalId}:{}),...(event.snapshotId?{snapshotId:event.snapshotId}:{})};
  return event?{state:'known',date:event.date,revision:event.after?.revision??event.before?.revision??null,eventId:event.id,
    ...(event.proposalId?{proposalId:event.proposalId}:{}),...(event.snapshotId?{snapshotId:event.snapshotId}:{}),...(!event.after?{deleted:true}:{})}
    :{state:complete?'not_recorded':'unknown',date:null,revision:null,eventId:null};
}
export function requirementHistory(doc:Workspace,id:string){
  const current=doc.requirements.find(r=>r.id===id),record=doc.requirementHistory?.[id];
  const events=record?.events??[],committed=events.filter(e=>e.committed);
  const observations=doc.baselines.flatMap(b=>b.requirements.some(r=>r.id===id)?[{date:b.date,snapshotId:b.id}]:[]).sort((a,b)=>a.date.localeCompare(b.date)||a.snapshotId.localeCompare(b.snapshotId));
  const historical=doc.baselines.flatMap(b=>b.requirements).find(r=>r.id===id)
    ??doc.proposals?.flatMap(p=>[...p.requirements,...p.baseRequirements]).find(r=>r.id===id);
  if(!current&&!record&&!historical)throw new ToolError('NOT_FOUND','Requirement history not found in this project. Check the project and requirement IDs.');
  const complete=record?.complete??false,last=committed.filter(e=>e.kind!=='reconciled').at(-1),latestValue=current??last?.after??last?.before??events.at(-1)?.after??historical;
  const statusEvents=(status:Requirement['status'])=>committed.filter(e=>e.source!=='import'&&(status==='Approved'&&e.lifecycle?.approval||status==='Implemented'&&e.lifecycle?.implementation||!e.lifecycle&&e.after?.status===status&&e.before?.status!==status));
  const approvals=statusEvents('Approved'),implementations=statusEvents('Implemented');
  const creation=events.find(e=>e.kind==='created'&&!e.proposalId||e.kind==='proposed_creation');
  // A later import gap cannot undo a first approval already recorded from birth.
  const firstImport=events.find(e=>e.source==='import');
  const firstApprovalKnown=complete||!!creation&&!!approvals[0]&&(!firstImport||approvals[0].sequence<firstImport.sequence);
  const accepted=committed.filter(e=>e.source==='proposal_apply'||e.kind==='reconciled'&&e.lifecycle?.approval).at(-1);
  const presence=current?'current':last&&!last.after?'deleted':committed.length||observations.length?'absent':'pending';
  return {project_id:doc.id,requirement_id:id,title:latestValue?.title??id,current_revision:current?.revision??null,current_status:current?.status??null,presence,
    coverage:{state:complete?'complete':'partial',message:complete?'Complete recorded history.':'Earlier history is missing. Unknown dates are not inferred from snapshots or rollout time.',first_observed:observations[0]??null},
    lifecycle:{created:milestone(creation,complete),last_changed:milestone(last,complete),last_change_accepted:milestone(accepted,complete,'acceptance'),
      first_approved:milestone(firstApprovalKnown?approvals[0]:undefined,complete,'approval'),first_known_approved:milestone(approvals[0],complete,'approval'),last_approved:milestone(approvals.at(-1),complete,'approval'),last_implemented:milestone(implementations.at(-1),complete,'implementation')},
    items:[...events].reverse().map(e=>({...e,proposalAvailable:!!e.proposalId&&!!doc.proposals?.some(p=>p.id===e.proposalId),snapshotAvailable:!!e.snapshotId&&doc.baselines.some(b=>b.id===e.snapshotId)}))};
}

export async function requirementHistoryPage(doc:Workspace,id:string,options:{limit?:number;cursor?:string}={}){
  const limit=options.limit??50;
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new ToolError('VALIDATION_ERROR','History limit must be an integer from 1 to 100.');
  const history=requirementHistory(doc,id),state=canonical({project:doc.id,id,version:doc.version,limit});
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(state)))).map(v=>v.toString(16).padStart(2,'0')).join('');
  let offset=0;
  if(options.cursor){
    let cursor;
    try{cursor=JSON.parse(atob(options.cursor));}catch{throw new ToolError('INVALID_CURSOR','Invalid history cursor. Restart without a cursor.');}
    if(!cursor||cursor.project!==doc.id||cursor.id!==id||cursor.limit!==limit||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw new ToolError('INVALID_CURSOR','Cursor belongs to a different history query. Restart without a cursor.');
    if(cursor.state!==digest)throw new ToolError('RESTART_REQUIRED','History changed during pagination. Restart without a cursor.');
    offset=cursor.offset;
    if(offset>history.items.length)throw new ToolError('INVALID_CURSOR','Invalid history offset. Restart without a cursor.');
  }
  return {...history,workspace_version:doc.version,requirements_version:setVersion(doc),items:history.items.slice(offset,offset+limit),
    ...(offset+limit<history.items.length?{next_cursor:btoa(JSON.stringify({project:doc.id,id,limit,state:digest,offset:offset+limit}))}:{})};
}
export type RequirementHistoryPage=Awaited<ReturnType<typeof requirementHistoryPage>>;
