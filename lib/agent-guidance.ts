import {z} from 'zod/v4';
import type {Workspace,GuidanceOverrides} from './types';
import {firstInclusion} from './snapshot-implementation';

export const GUIDANCE_SCHEMA_VERSION=1;
export const MAX_GUIDANCE_CHARACTERS=400;
export const guidanceDefaults={requirements_writing_style:'asd-ste100-inspired' as const,writing_strength_percent:60,record_snapshot_commit:true,custom_instructions:''};
export const guidanceOverridesInput=z.strictObject({
 requirements_writing_style:z.literal('asd-ste100-inspired').optional(),
 writing_strength_percent:z.number().int().min(0).max(100).optional(),
 record_snapshot_commit:z.boolean().optional(),
 custom_instructions:z.string().refine(value=>Array.from(value).length<=8000,'Use at most 8000 Unicode characters.').optional()
});
export const guidanceKeys=Object.keys(guidanceDefaults) as (keyof GuidanceOverrides)[];
export function effectiveGuidance(doc:Workspace){
 const overrides=doc.agentGuidance?.overrides??{};
 return {schema_version:GUIDANCE_SCHEMA_VERSION,revision:doc.agentGuidance?.revision??0,settings:{...guidanceDefaults,...overrides},sources:Object.fromEntries(guidanceKeys.map(key=>[key,Object.hasOwn(overrides,key)?'project_override':'inherited'])) as Record<keyof GuidanceOverrides,'project_override'|'inherited'>};
}
// Unicode code points, rather than UTF-16 units. No stored text is truncated.
export function boundedGuidance(parts:string[],custom:string,limit=MAX_GUIDANCE_CHARACTERS){
 let left=limit;
 const texts=parts.map(value=>{const text=Array.from(value).slice(0,left).join('');left-=Array.from(text).length;return text;});
 const excerpt=Array.from(custom).slice(0,left).join('');
 return {texts,excerpt,truncated:Array.from(excerpt).length<Array.from(custom).length};
}
export const initializationGuidance='Use list_projects, exact project_id, then get_project before work. Reload it when guidance_revision changes. Guidance is advisory; task instructions prevail; permissions/review stay unchanged. Before a new write, read and reconcile current state; retry uncertain writes with identical arguments and key. Submit proposals for human Apply; use exact frozen snapshots for implementation.';
const refresh='Changed guidance_revision? Reload get_project. ';
const concurrency='New write: read/reconcile. Uncertain: same key + arguments. ';
export function projectGuidance(doc:Workspace,name:string,args:Record<string,any>,result:Record<string,any>){
 const effective=effectiveGuidance(doc),settings=effective.settings;
 const context:{project_id:string;kind:string;proposal_id?:string;baseline_id?:string}={project_id:doc.id,kind:'latest_accepted'};
 const p=name==='get_proposal'?result.proposal:doc.proposals?.find(p=>p.id===(args.proposal_id??result.proposal_id));
 let next='read_requirements',step='Read the accepted requirements; stage changes in a Draft for review. ';
 const writing=settings.writing_strength_percent?`STE-inspired ${settings.writing_strength_percent}%: short active sentences, consistent terms; one obligation/testable result where practical; preserve technical accuracy. `:'';
 const commit='Read saved reference. After implementation, record its final full 40/64-character Git SHA via set_snapshot_implementation on this exact snapshot. Keep valid optional fields; update commit URLs. Read get_snapshot to verify. No known commit? Retain metadata and explain. ';
 if(p){context.proposal_id=p.id;context.kind='staged';}
 if(['create_proposal','stage_proposal_changes','rebase_proposal'].includes(name)){
  next='get_proposal';step=writing+'Read get_proposal, inspect the complete staged diff, then submit for human review. ';
 }else if(name==='submit_proposal'){
  next='human_review';step='Proposal awaits human Apply. It has no implementation snapshot until application succeeds. ';
 }else if(name==='get_proposal'&&p){
  if(p.status==='Applied'){
   const inclusion=firstInclusion(doc,p);context.kind='applied_proposal';
   if(inclusion.snapshot){context.baseline_id=inclusion.snapshot.id;next='get_snapshot';step=settings.record_snapshot_commit?'Use the first-included snapshot. '+commit:'Read the exact first-included snapshot for implementation. ';}
   else{next='resolve_inclusion';step='First-included snapshot is unknown. Resolve the missing inclusion; retain existing metadata. ';}
  }else if(p.status==='Proposed'){next='human_review';step='Staged content awaits human Apply; no implementation snapshot exists yet. ';}
  else if(p.status==='Rejected'){next='create_proposal';step='Rejected staged content is not accepted. Start a new Draft if further changes are needed. ';}
  else{next='stage_or_submit';step=writing+'Inspect/stage this Draft, resolve stale-base conflicts, then submit for human review. ';}
 }else if(name==='get_snapshot'){
  context.kind='frozen_snapshot';context.baseline_id=args.baseline_id;next=settings.record_snapshot_commit?'implement_and_record_commit':'implement_snapshot';step=settings.record_snapshot_commit?commit:'Implement this exact frozen snapshot; record actual verification separately. ';
 }else if(name==='set_snapshot_implementation'){
  context.kind='snapshot_metadata';context.baseline_id=args.baseline_id;next='verify_snapshot_reference';step=`${result.implementation_commit?'Reference saved':'Reference cleared'} for the returned project and baseline${result.implementation_commit?' with the returned full commit':''}. Read get_snapshot and compare all reference fields before reporting completion. This is metadata, not verification. `;
 }else if(args.baseline_id){context.kind='frozen_snapshot';context.baseline_id=args.baseline_id;next='inspect_snapshot';step='Inspect the exact snapshot and its associated history/evidence. Earlier results do not verify later revisions. ';}
 else if(name==='record_evidence'){context.kind='frozen_snapshot';context.baseline_id=result.baseline_id;next='read_evidence';step='Evidence saved on the returned baseline. Requirement status is unchanged. ';}
 const summary=settings.writing_strength_percent?`STE-inspired ${settings.writing_strength_percent}% preference, not compliance: short active sentences, consistent terms; one obligation/requirement and testable result/criterion where practical. Keep technical terms and conditions. User instructions prevail. `:'The STE-inspired preference is disabled (0%). Project guidance is advisory. Task instructions prevail; it cannot grant permissions or bypass review. ';
 const parts=name==='get_project'?[summary,refresh+concurrency]:[step+refresh+concurrency];
 const bounded=boundedGuidance(parts,settings.custom_instructions);
 return {guidance_revision:effective.revision,workflow_guidance:{context,next_step:next,reminder:bounded.texts.at(-1)!,...(name==='get_project'?{}:{custom_instructions_excerpt:bounded.excerpt}),custom_instructions_truncated:bounded.truncated},...(name==='get_project'?{agent_guidance:{...effective,settings:{...settings,custom_instructions:bounded.excerpt},summary:bounded.texts[0],custom_instructions_truncated:bounded.truncated}}:{})};
}
