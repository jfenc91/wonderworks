import type {Workspace,Requirement,ChangeProposal,LifecycleRecord,AcceptanceRecord,ImplementationSupport} from './types';
import {canonical,exactRevision,sameRequirement} from './authored';
import {normative} from './item-content';

export function pendingRequirements(doc:Workspace,p:ChangeProposal):Requirement[]{
  if(!['Draft','Proposed'].includes(p.status))return p.requirements;
  return p.requirements.map(r=>{
    if(!normative(r))return r;
    const base=p.baseRequirements.find(v=>v.id===r.id),current=doc.requirements.find(v=>v.id===r.id);
    return {...r,status:base&&sameRequirement(base,r)?(current&&exactRevision(current,r)?current.status:base.status):'Draft'};
  });
}
export function pendingRevision(p:ChangeProposal,r:Requirement){return ['Draft','Proposed'].includes(p.status)&&normative(r)&&!sameRequirement(p.baseRequirements.find(v=>v.id===r.id),r);}
export function validateStatusEcho(doc:Workspace,p:ChangeProposal,input:Partial<Requirement>,existing?:Requirement){
  if((input.kind??existing?.kind)==='information'||input.status===undefined)return;
  const read=pendingRequirements(doc,p).find(r=>r.id===existing?.id);
  const allowed=existing?[existing.status,read?.status]:['Draft'];
  if(!allowed.includes(input.status))throw Error('Requirement status is system-maintained. Echo the unchanged read-back status or omit it (Draft for additions). Apply approves a revision; record a commit on an exact matching snapshot to implement it.');
}
export function matchingSupports(doc:Workspace,r:Requirement):ImplementationSupport[]{
  if(!normative(r))return [];
  return doc.baselines.flatMap(b=>{
    const saved=doc.snapshotImplementations?.[b.id],commit=saved?.implementation_commit;
    return commit&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit.commit_id)&&b.requirements.some(v=>normative(v)&&exactRevision(v,r))?[{baseline_id:b.id,commit:structuredClone(commit),recorded_at:saved?.updated_at??null}]:[];
  }).sort((a,b)=>a.baseline_id.localeCompare(b.baseline_id));
}
export function currentRecord(doc:Workspace,r:Requirement){const entry=doc.requirementLifecycle?.[r.id];return entry?.revision===r.revision?entry:undefined;}
export function acceptRevisions(doc:Workspace,p:ChangeProposal,previous:Requirement[]){
  for(const r of doc.requirements){
    const old=previous.find(v=>v.id===r.id);
    if(!normative(r)||sameRequirement(old,r))continue;
    doc.requirementLifecycle??={};
    doc.requirementLifecycle[r.id]={revision:r.revision,acceptance:{proposal_id:p.id,snapshot_id:p.appliedSnapshot!,date:doc.baselines.find(b=>b.id===p.appliedSnapshot)!.date,recovered:false},managedImplementation:false,legacyImplementation:false,supports:[]};
  }
}
// A historical proposal proves acceptance only for content it actually changed.
// An unchanged item's presence in its resulting snapshot is insufficient.
export function savedAcceptance(doc:Workspace,r:Requirement):AcceptanceRecord|undefined{
  const candidates=(doc.proposals??[]).flatMap(p=>{
    if(p.status!=='Applied')return [];
    const after=p.requirements.find(v=>v.id===r.id),base=p.baseRequirements.find(v=>v.id===r.id);
    const snapshot=doc.baselines.find(b=>b.id===p.appliedSnapshot);
    if(!after||sameRequirement(base,after)||!exactRevision(after,r)||!snapshot?.requirements.some(v=>exactRevision(v,r)))return [];
    // The snapshot's creation time is unambiguous only when the saved Apply
    // link and requirement-set version agree. Do not infer from free text.
    const known=!!p.appliedVersion&&p.appliedVersion===snapshot.requirementsVersion&&Number.isFinite(Date.parse(snapshot.date));
    return [{proposal_id:p.id,snapshot_id:snapshot.id,date:known?snapshot.date:null,recovered:true}];
  });
  return candidates.sort((a,b)=>(b.date??'').localeCompare(a.date??''))[0];
}
function initialRecord(doc:Workspace,r:Requirement):LifecycleRecord{
  return structuredClone(currentRecord(doc,r)??{revision:r.revision,managedImplementation:false,legacyImplementation:r.status==='Implemented',supports:[]});
}
// Invoked only by explicit writes. Read models below never mutate the document.
export function synchronizeImplementation(doc:Workspace,baselineId:string){
  const target=doc.baselines.find(b=>b.id===baselineId)!;
  const affected=[];
  for(const r of doc.requirements){
    if(!normative(r)||!target.requirements.some(v=>normative(v)&&exactRevision(v,r)))continue;
    const entry=initialRecord(doc,r),supports=matchingSupports(doc,r);
    if(supports.length){r.status='Implemented';entry.managedImplementation=true;}
    else if(entry.managedImplementation&&!entry.legacyImplementation){r.status='Approved';entry.managedImplementation=false;}
    entry.supports=supports;doc.requirementLifecycle??={};doc.requirementLifecycle[r.id]=entry;
    affected.push({requirement_id:r.id,revision:r.revision,status:r.status,supports});
  }
  return affected;
}
export function reconcileLifecycle(doc:Workspace){
  const before=canonical({requirements:doc.requirements,lifecycle:doc.requirementLifecycle});
  const affected=[];
  for(const r of doc.requirements){
    if(!normative(r))continue;
    const entry=initialRecord(doc,r),acceptance=entry.acceptance??savedAcceptance(doc,r),supports=matchingSupports(doc,r);
    if(acceptance)entry.acceptance=acceptance;
    if(supports.length){r.status='Implemented';entry.managedImplementation=true;}
    else if(entry.managedImplementation&&!entry.legacyImplementation){r.status='Approved';entry.managedImplementation=false;}
    else if(r.status==='Draft'&&acceptance)r.status='Approved';
    entry.supports=supports;entry.reconciled=true;doc.requirementLifecycle??={};doc.requirementLifecycle[r.id]=entry;
    affected.push({requirement_id:r.id,revision:r.revision,status:r.status,supports});
  }
  return {changed:before!==canonical({requirements:doc.requirements,lifecycle:doc.requirementLifecycle}),affected};
}
export function lifecycleState(doc:Workspace,r:Requirement){
  const entry=currentRecord(doc,r),supports=matchingSupports(doc,r),acceptance=entry?.acceptance??null;
  const missing:string[]=[];
  if(normative(r)){
    if(!acceptance)missing.push('Acceptance provenance is missing for this revision.');
    if((entry?.legacyImplementation||r.status==='Implemented'&&!entry?.managedImplementation))missing.push('Legacy manual implementation has unknown support; review required.');
    if(supports.length&&r.status!=='Implemented')missing.push('Matching commit records exist; run explicit lifecycle reconciliation.');
    if(!supports.length&&r.status==='Implemented')missing.push('No matching saved implementation commit.');
  }
  return {context:normative(r)?'accepted' as const:'editorial' as const,revision:r.revision,status:r.status,acceptance,supports,missing_provenance:missing,assertion:'Saved commits are user assertions of implementation; code and verification are not checked.'};
}
export function proposalLifecycle(doc:Workspace,p:ChangeProposal){
  return pendingRequirements(doc,p).map(r=>pendingRevision(p,r)?{requirement_id:r.id,revision:r.revision,context:'pending' as const,status:'Draft' as const,expected_on_apply:'Approved' as const}:{requirement_id:r.id,...lifecycleState(doc,r),context:['Draft','Proposed'].includes(p.status)?(normative(r)?'accepted' as const:'editorial' as const):'historical' as const});
}
