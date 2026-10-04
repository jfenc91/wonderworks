import {inheritRich,validateItem,validateReferences,initializeSourceReviews,validateReviewMarkers} from './item-content';
import {validateDiagrams} from './diagrams';
import {z} from 'zod';
import {tagsOf,withTags} from './tags';
import type {Workspace, Requirement, ChangeProposal, Repository} from './types';
import {nextId, record, requirementInput, validateDependencies} from './requirements';

import {authored,authoredFields,requirementFields,canonical,sameRequirement} from './authored';
import {validateStatusEcho,acceptRevisions,pendingRequirements} from './lifecycle';
export {authoredFields,requirementFields,canonical,sameRequirement} from './authored';
export function setVersion(doc:Workspace) { return doc.requirementsVersion ?? 1; }
export function setContent(doc:Pick<Workspace,'requirements'|'sections'>) { return canonical({requirements:doc.requirements.map(r=>({id:r.id,revision:r.revision,...authored(r)})),sections:doc.sections}); }
export function requirementChanges(before:Requirement[],after:Requirement[]) {
  const ids=[...new Set([...before.map(r=>r.id),...after.map(r=>r.id)])];
  return ids.flatMap(id=>{
    const old=before.find(r=>r.id===id),next=after.find(r=>r.id===id);
    if (sameRequirement(old,next)&&!(next?.kind==='information'&&old?.status!==next.status)) return [];
    return [{id,before:old,after:next,kind:!old?'Added':!next?'Deleted':'Edited',fields:(next?.kind==='information'?requirementFields:authoredFields).filter(f=>canonical(f==='tags'&&old?tagsOf(old):old?.[f])!==canonical(f==='tags'&&next?tagsOf(next):next?.[f]))}];
  });
}
export function isStale(doc:Workspace,p:ChangeProposal) {
  return p.baseVersion!==setVersion(doc) || setContent({requirements:p.baseRequirements,sections:p.baseSections})!==setContent(doc);
}
export function proposalConflicts(doc:Workspace,p:ChangeProposal) {
  return [...new Set([...p.baseRequirements,...p.requirements,...doc.requirements].map(r=>r.id))].filter(id=>{
    const base=p.baseRequirements.find(r=>r.id===id),ours=p.requirements.find(r=>r.id===id),latest=doc.requirements.find(r=>r.id===id);
    return !sameRequirement(base,ours) && !sameRequirement(base,latest) && !sameRequirement(ours,latest);
  });
}
export const repositoryInput=z.object({
  id:z.string().optional(),name:z.string().trim().min(2).max(80),
  url:z.string().trim().url().max(500).refine(value=>{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;},'Use an HTTP or HTTPS repository URL without credentials'),
  branch:z.string().trim().max(120).default('')
});
export function saveRepository(doc:Workspace,input:unknown) {
  const data=repositoryInput.parse(input);doc.repositories??=[];
  if(data.id && !doc.repositories.some(r=>r.id===data.id)) throw Error('Repository link no longer exists');
  const repository:Repository={...data,id:data.id??crypto.randomUUID()};
  const index=doc.repositories.findIndex(r=>r.id===repository.id);
  if(index<0)doc.repositories.push(repository);else doc.repositories[index]=repository;
  record(doc,`Repository linked · ${repository.name}`);
}
const proposalInput=z.object({title:z.string().trim().min(3).max(120),description:z.string().trim().max(3000).default('')});
export function createProposal(doc:Workspace,input:unknown) {
  const data=proposalInput.parse(input);doc.proposals??=[];
  const sequence=doc.proposals.reduce((n,p)=>Math.max(n,Number(p.id.split('-')[1])||0),0)+1;
  const now=new Date().toISOString();
  const p:ChangeProposal={...data,id:`CP-${String(sequence).padStart(3,'0')}`,status:'Draft',createdAt:now,updatedAt:now,baseVersion:setVersion(doc),baseRequirements:structuredClone(doc.requirements).map(withTags),baseSections:structuredClone(doc.sections),requirements:structuredClone(doc.requirements).map(withTags)};
  doc.proposals.unshift(p);record(doc,`${p.id} drafted · ${p.title}`);return p;
}
export function getProposal(doc:Workspace,id:unknown,editable=false) {
  const p=doc.proposals?.find(p=>p.id===id);
  if(!p)throw Error('Change proposal not found');
  if(editable && p.status!=='Draft')throw Error('Only draft proposals can be edited');
  return p;
}
export function updateProposal(doc:Workspace,id:unknown,input:unknown) {
  const p=getProposal(doc,id,true);Object.assign(p,proposalInput.parse(input),{updatedAt:new Date().toISOString()});
  record(doc,`${p.id} details updated`);
}
function revised(requirement:Requirement,base?:Requirement):Requirement {
  return {...withTags(requirement),revision:base?(sameRequirement(base,requirement)?base.revision:base.revision+1):Math.max(1,requirement.revision)};
}
export function editProposalRequirement(doc:Workspace,id:unknown,input:unknown) {
  const p=getProposal(doc,id,true);let data=requirementInput.parse(input);
  if(!doc.sections.some(s=>s.id===data.section))throw Error('Choose an existing section');
  const existing=p.requirements.find(r=>r.id===data.id);
  if(data.id&&!existing)throw Error('Requirement is not in this proposal');
  validateStatusEcho(doc,p,input as Partial<Requirement>,existing);
  data=inheritRich(data,existing);data.status=(input as Partial<Requirement>).status??existing?.status??'Draft';validateItem(data);
  const requirementId=existing?.id??nextId(doc);
  const candidate=revised({...data,tags:data.tags??tagsOf(existing??{}),id:requirementId,revision:existing?.revision??1},p.baseRequirements.find(r=>r.id===requirementId));
  if(candidate.kind!=='information'){const base=p.baseRequirements.find(r=>r.id===candidate.id);candidate.status=base&&sameRequirement(base,candidate)?(doc.requirements.find(r=>r.id===candidate.id)?.status??base.status):'Draft';}
  if(existing&&sameRequirement(existing,candidate)&&existing.status===candidate.status)return;
  if(existing)p.requirements[p.requirements.indexOf(existing)]=candidate;else p.requirements.push(candidate);
  p.updatedAt=new Date().toISOString();record(doc,`${p.id} staged ${requirementId} · ${candidate.title}`,[requirementId]);
}
export function deleteProposalRequirement(doc:Workspace,id:unknown,requirementId:unknown) {
  const p=getProposal(doc,id,true);
  if(!p.requirements.some(r=>r.id===requirementId))throw Error('Requirement is not in this proposal');
  p.requirements=p.requirements.filter(r=>r.id!==requirementId);p.updatedAt=new Date().toISOString();
  record(doc,`${p.id} staged removal of ${requirementId}`,[String(requirementId)]);
}
export function restoreProposalRequirement(doc:Workspace,id:unknown,requirementId:unknown) {
  const p=getProposal(doc,id,true),base=p.baseRequirements.find(r=>r.id===requirementId);
  if(!base&&!p.requirements.some(r=>r.id===requirementId))throw Error('Requirement is not in this proposal');
  p.requirements=p.requirements.filter(r=>r.id!==requirementId);
  if(base){
    p.requirements.push(structuredClone(base));
    const rank=new Map(p.baseRequirements.map((r,index)=>[r.id,index]));
    p.requirements.sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));
  }
  p.updatedAt=new Date().toISOString();record(doc,`${p.id} unstaged ${requirementId}`,[String(requirementId)]);
}
export function validateSet(doc:Workspace,requirements:Requirement[]) {
  if(new Set(requirements.map(r=>r.id)).size!==requirements.length)throw Error('Duplicate requirement IDs');
  for(const r of requirements){
    requirementInput.parse(r);validateItem(r);
    if(!doc.sections.some(s=>s.id===r.section))throw Error(`${r.id}: choose an existing section`);
    if(r.links.some(id=>id===r.id||!requirements.some(other=>other.id===id)))throw Error(`${r.id}: remove missing or self-referencing dependencies`);
  }
  validateReferences(requirements);validateDependencies({...doc,requirements});
}
export function submitProposal(doc:Workspace,id:unknown) {
  const p=getProposal(doc,id,true);
  if(isStale(doc,p))throw Error('Refresh this proposal from the latest requirement set before submitting');
  if(!requirementChanges(p.baseRequirements,p.requirements).length)throw Error('Stage at least one requirement change');
  initializeSourceReviews(p.requirements,p.baseRequirements);validateSet(doc,p.requirements);validateReviewMarkers(p.requirements,p.baseRequirements);validateDiagrams(p.requirements);p.status='Proposed';p.updatedAt=new Date().toISOString();
  record(doc,`${p.id} proposed for review · ${p.title}`);
}
export function rebaseProposal(doc:Workspace,id:unknown,input:unknown) {
  const p=getProposal(doc,id);
  if(!['Draft','Proposed'].includes(p.status))throw Error('This proposal is closed');
  const resolutions=z.record(z.enum(['proposed','latest'])).parse(input??{});
  const conflicts=proposalConflicts(doc,p);
  if(conflicts.some(id=>!resolutions[id]))throw Error('Choose a resolution for every conflicting requirement');
  const ids=[...new Set([...doc.requirements,...p.requirements,...p.baseRequirements].map(r=>r.id))];
  const requirements=ids.flatMap(id=>{
    const base=p.baseRequirements.find(r=>r.id===id),ours=p.requirements.find(r=>r.id===id),latest=doc.requirements.find(r=>r.id===id);
    const picked=conflicts.includes(id)?(resolutions[id]==='proposed'?ours:latest):sameRequirement(ours,base)?latest:ours;
    return picked?[revised(structuredClone(picked),latest)]:[];
  });
  validateSet(doc,requirements);
  p.requirements=requirements;p.baseRequirements=structuredClone(doc.requirements).map(withTags);p.baseSections=structuredClone(doc.sections);
  p.requirements=pendingRequirements(doc,p);p.baseVersion=setVersion(doc);p.status='Draft';p.updatedAt=new Date().toISOString();
  record(doc,`${p.id} refreshed onto requirement set v${p.baseVersion}; review required`);
}
export function snapshot(doc:Workspace,name:unknown) {
  const title=z.string().trim().min(2).max(160).parse(name);
  const sequence=doc.baselines.reduce((n,b)=>Math.max(n,Number(b.id.split('-')[1])||0),0)+1;
  const b={id:`BL-${String(sequence).padStart(3,'0')}`,date:new Date().toISOString(),name:title,requirementsVersion:setVersion(doc),requirements:structuredClone(doc.requirements).map(withTags),sections:structuredClone(doc.sections),repositories:structuredClone(doc.repositories??[])};
  doc.baselines.unshift(b);record(doc,`${b.id} snapshotted requirement set v${b.requirementsVersion} · ${title}`);return b;
}
export function reviewProposal(doc:Workspace,id:unknown,input:unknown) {
  const p=getProposal(doc,id);
  if(p.status!=='Proposed')throw Error('Only proposals submitted for review can receive a decision');
  const decision=z.object({decision:z.enum(['apply','reject','request_changes']),note:z.string().trim().max(3000).default('')}).parse(input);
  if(decision.decision==='apply'){
    if(isStale(doc,p))throw Error('Requirements changed during review. Refresh the proposal and review it again before applying');
    if(!requirementChanges(doc.requirements,p.requirements).length)throw Error('This proposal has no changes to apply');
    validateSet(doc,p.requirements);validateReviewMarkers(p.requirements,p.baseRequirements);validateDiagrams(p.requirements);
    const previous=doc.requirements;
    const authoredChange=requirementChanges(previous,p.requirements).some(c=>!sameRequirement(c.before,c.after));
    doc.requirements=structuredClone(p.requirements).map(r=>{const old=previous.find(v=>v.id===r.id);const next=revised(r,old);if(r.kind!=='information')next.status=old&&sameRequirement(old,r)?old.status:'Approved';return next;});
    if(authoredChange)doc.requirementsVersion=setVersion(doc)+1;p.status='Applied';p.appliedVersion=setVersion(doc);
    p.appliedSnapshot=snapshot(doc,`${p.id} · ${p.title}`).id;
    acceptRevisions(doc,p,previous);
  }else p.status=decision.decision==='reject'?'Rejected':'Draft';
  p.reviewNote=decision.note;p.updatedAt=new Date().toISOString();
  record(doc,`${p.id} ${decision.decision==='request_changes'?'changes requested':p.status.toLowerCase()}${decision.note?' · '+decision.note:''}`);
}
