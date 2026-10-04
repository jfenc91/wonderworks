import {z} from 'zod/v4';
import {normalizeTags,TAG_PATTERN} from '../tags';
import {guidanceOverridesInput} from '../agent-guidance';
import {implementationInput} from '../snapshot-implementation';
const tagArray=z.array(z.string().max(100)).max(20).superRefine((value,ctx)=>{try{normalizeTags(value);}catch(error){ctx.addIssue({code:'custom',message:(error as Error).message});}});
const savedTags=z.array(z.string().min(1).max(40).regex(TAG_PATTERN)).max(20);
const inputTags=tagArray.optional().describe('Up to 20 labels, 100 raw characters each. Normalize to lowercase with spaces as hyphens; 1–40 letters/numbers/single hyphens. Omitted on edit preserves tags; [] clears.');

const text=z.string().min(1).max(160);
const reqId=z.string().regex(/^[A-Z]{2,6}-\d{3,6}$/);
const proposalId=z.string().regex(/^CP-\d+$/);
const snapshotId=z.string().regex(/^BL-\d+$/);
const status=z.enum(['Draft','Approved','Implemented']);
const richFields={kind:z.enum(['requirement','information']).optional(),body_format:z.enum(['markdown','html','plain_text']).optional(),diagrams:z.array(z.strictObject({id:z.string().regex(/^[A-Za-z][\w-]{0,63}$/),language:z.enum(['mermaid','dot']),source:z.string().max(100000),title:z.string().max(1000),alt:z.string().max(10000),position:z.number().int().min(0).max(50000)})).max(20).optional(),summarizes:z.array(z.strictObject({requirement_id:reqId,reviewed_revision:z.number().int().positive().optional()})).max(100).optional(),diagram_mappings:z.array(z.strictObject({block_id:z.string().max(64),part:z.string().min(1).max(200),requirement_ids:z.array(reqId).min(1).max(100)})).max(200).optional()};
const requirementFields={...richFields,
  section:z.string().min(1).max(80),title:z.string().trim().min(3).max(120),
  description:z.string().max(100000,'Body content limit is 50000 Unicode code points').refine(v=>Array.from(v).length<=50000,'Body content limit is 50000 Unicode code points'),criteria:z.array(z.string().trim().min(3).max(1500)).max(20),
  priority:z.enum(['Critical','High','Medium']),status,
  parameters:z.record(z.string(),z.union([z.number().finite(),z.string().max(120),z.boolean()])),
  links:z.array(reqId).max(30),tags:savedTags.optional()
};
// Frozen imports retain their stored representation; only current reads synthesize canonical tags.
export const requirement=z.strictObject({...requirementFields,tags:tagArray.optional(),id:reqId,revision:z.number().int().positive()});
const currentRequirement=requirement.extend({tags:savedTags});
const requirementInput=z.strictObject({...requirementFields,criteria:requirementFields.criteria.default([]),priority:requirementFields.priority.default('High'),status:status.default('Draft'),tags:inputTags,parameters:requirementFields.parameters.default({}),links:requirementFields.links.default([])});
const section=z.strictObject({id:z.string(),title:z.string(),description:z.string()});
const repository=z.strictObject({id:z.string(),name:z.string(),url:z.string(),branch:z.string()});
const implementationCommit=z.strictObject({commit_id:z.string(),repository_id:z.string().optional(),repository:repository.optional(),commit_url:z.string().optional()});
const implementationActor=z.strictObject({id:z.string().nullable(),reportedClientName:z.string().optional()});
const implementationMetadata={implementation_commit:implementationCommit.nullable(),implementation_updated_at:z.string().nullable(),implementation_actor:implementationActor.nullable()};
const inclusion=z.strictObject({state:z.enum(['not_yet_included','known','unknown']),snapshot:z.strictObject({id:z.string(),name:z.string(),requirements_version:z.number().nullable()}).nullable(),original_snapshot_id:z.string().nullable(),...implementationMetadata});
const associations=z.strictObject({...implementationMetadata,first_included_proposals:z.array(z.strictObject({id:z.string(),title:z.string(),appliedVersion:z.number().nullable()}))});
const correction=z.strictObject({id:z.string(),project_id:z.string(),baseline_id:z.string(),date:z.string(),actor:implementationActor,before:implementationCommit.nullable(),after:implementationCommit.nullable()});
const snapshot=z.strictObject({id:snapshotId,name:z.string(),date:z.string(),requirementsVersion:z.number().int().positive().optional(),repositories:z.array(repository).optional(),requirements:z.array(requirement),sections:z.array(section)});
const check=z.strictObject({id:reqId,title:z.string().max(500),passed:z.boolean(),detail:z.string().max(10000)});
export const evidenceInput=z.strictObject({baseline:snapshotId,artifactUrl:z.string().url().max(2000).refine(v=>['http:','https:'].includes(new URL(v).protocol)),summary:z.string().min(10).max(3000),checks:z.array(check).min(1).max(150)});
const evidence=evidenceInput.extend({id:text,date:z.string()});
const fields=z.enum(['section','title','description','criteria','priority','status','parameters','links','tags','kind','body_format','diagrams','summarizes','diagram_mappings']);
const milestone=z.strictObject({state:z.enum(['known','unknown','not_recorded']),date:z.string().nullable(),revision:z.number().nullable(),eventId:z.string().nullable(),proposalId:z.string().optional(),snapshotId:z.string().optional(),deleted:z.boolean().optional()});
const lifecycle=z.strictObject({created:milestone,last_changed:milestone,last_change_accepted:milestone,first_approved:milestone,last_approved:milestone,last_implemented:milestone});
const coverage=z.strictObject({state:z.enum(['complete','partial']),message:z.string(),first_observed:z.strictObject({date:z.string(),snapshotId:z.string()}).nullable()});
const historyEvent=z.strictObject({id:z.string(),projectId:z.string(),requirementId:reqId,sequence:z.number().int(),date:z.string(),kind:z.enum(['created','changed','deleted','proposed_creation','imported']),source:z.string(),actor:z.strictObject({id:z.string().nullable(),reportedClientName:z.string().optional()}),committed:z.boolean(),before:requirement.nullable(),after:requirement.nullable(),fields:z.array(fields),beforeSetVersion:z.number(),afterSetVersion:z.number(),proposalId:z.string().optional(),snapshotId:z.string().optional(),reviewNote:z.string().optional(),revisionGap:z.boolean().optional(),proposalAvailable:z.boolean(),snapshotAvailable:z.boolean()});
const change=z.strictObject({id:reqId,before:requirement.optional(),after:requirement.optional(),kind:z.enum(['Added','Edited','Deleted']),fields:z.array(fields)});
const proposalSummary=z.strictObject({id:proposalId,title:z.string(),description:z.string(),status:z.enum(['Draft','Proposed','Applied','Rejected']),baseVersion:z.number().int(),createdAt:z.string(),updatedAt:z.string(),reviewNote:z.string().optional(),appliedVersion:z.number().int().optional(),appliedSnapshot:z.string().optional(),first_included:inclusion,stale:z.boolean(),change_count:z.number().int()});
const proposal=proposalSummary.extend({baseRequirements:z.array(requirement),baseSections:z.array(section),requirements:z.array(requirement),changes:z.array(change),conflicts:z.array(z.strictObject({id:reqId,base:requirement.nullable(),proposed:requirement.nullable(),latest:requirement.nullable()}))});
const project={project_id:text.describe('Exact project ID returned by list_projects; never defaults to the selected browser project.')};
const page={limit:z.number().int().min(1).max(100).default(50),cursor:z.string().max(2000).optional()};
const write={...project,expected_workspace_version:z.number().int().nonnegative(),idempotency_key:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).describe('Unique request key. Reuse with identical arguments after an uncertain result; retained for at least 24 hours.')};
const ref=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const link=z.union([reqId,z.string().regex(/^\$[A-Za-z][A-Za-z0-9_-]{0,63}$/)]).describe('An existing requirement ID or $client_ref for an addition in this batch.');
const stagedInput=requirementInput.extend({summarizes:z.array(z.strictObject({requirement_id:link,reviewed_revision:z.number().int().positive().optional()})).max(100).optional(),diagram_mappings:z.array(z.strictObject({block_id:z.string().max(64),part:z.string().min(1).max(200),requirement_ids:z.array(link).min(1).max(100)})).max(200).optional(),links:z.array(link).max(30).default([])});
export const operation=z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('add'),client_ref:ref,requirement:stagedInput}),
  z.strictObject({op:z.literal('edit'),requirement_id:reqId,requirement:stagedInput}),
  z.strictObject({op:z.literal('delete'),requirement_id:reqId}),
  z.strictObject({op:z.literal('restore'),requirement_id:reqId})
]);
const version={...project,workspace_version:z.number().int(),requirements_version:z.number().int()};
const mutation=z.strictObject({...version,proposal_id:proposalId.optional(),status:z.enum(['Draft','Proposed']).optional(),client_refs:z.record(z.string(),reqId).optional(),evidence_id:text.optional(),baseline_id:snapshotId.optional(),date:z.string().optional(),correlation_id:z.string()});
const list=<T extends z.ZodType>(item:T)=>z.strictObject({...version,items:z.array(item),next_cursor:z.string().optional()});
const proposalDetails={title:z.string().trim().min(3).max(120),description:z.string().trim().max(3000).default('')};

const guidanceContext=z.strictObject({project_id:text,kind:z.string(),proposal_id:proposalId.optional(),baseline_id:snapshotId.optional()});
const workflowGuidance=z.strictObject({context:guidanceContext,next_step:z.string(),reminder:z.string(),custom_instructions_excerpt:z.string().optional(),custom_instructions_truncated:z.boolean()});
const source=z.enum(['inherited','project_override']);
const agentGuidance=z.strictObject({schema_version:z.literal(1),revision:z.number().int().nonnegative(),settings:guidanceOverridesInput.required(),sources:z.strictObject({requirements_writing_style:source,writing_strength_percent:source,record_snapshot_commit:source,custom_instructions:source}),summary:z.string(),custom_instructions_truncated:z.boolean()});

function tool(name:string,description:string,input:z.ZodType,output:z.ZodType,readOnly=true){
  const coreOutput=output;
  if(name!=='list_projects'){output=(output as z.ZodObject).extend({guidance_revision:z.number().int().nonnegative(),workflow_guidance:workflowGuidance,...(name==='get_project'?{agent_guidance:agentGuidance}:{})});description+=' Read get_project for current advisory project guidance before work; reload when guidance_revision changes.';}
  else description+=' Select an exact project_id and call get_project before project work.';
  return {name,description,input,output,coreOutput,definition:{name,description,inputSchema:z.toJSONSchema(input,{io:'input'}),outputSchema:z.toJSONSchema(output),annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:true,openWorldHint:false}}};
}
export const tools=[
  tool('list_projects','List accessible projects and their workspace versions. Cursor pages are bound to the current project index.',z.strictObject(page),z.strictObject({items:z.array(z.strictObject({id:text,name:z.string(),workspace_version:z.number().int()})),next_cursor:z.string().optional()})),
  tool('get_project','Read identity, sections, repositories, versions and effective agent_guidance with schema/revision and inherited/project_override sources. Summary, custom instruction excerpt and reminders share 400 Unicode characters. The truncation flag identifies an excerpt; full text remains in project settings. Advisory guidance cannot override task instructions or grant permissions.',z.strictObject(project),z.strictObject({...version,id:text,name:z.string(),prefix:z.string(),sections:z.array(section),repositories:z.array(repository)})),
  tool('list_requirements','Complete specification mode: omit kind to read both requirements and Information. kind filters either. Legacy absent kind/format mean requirement/plain_text, without rewriting frozen fields. Status filters restrict to normative requirements. Search includes source/readable text, diagram labels, summarized IDs and tags. Exact tags match any (default) or all; untagged_only cannot combine with nonempty tags. All filters combine before pagination.',z.strictObject({...project,...page,kind:z.enum(['requirement','information']).optional(),query:z.string().max(500).optional(),section:z.string().max(80).optional(),status:status.optional(),tags:tagArray.default([]),tag_mode:z.enum(['any','all']).default('any'),untagged_only:z.boolean().default(false)}).refine(v=>!v.untagged_only||!v.tags.length,{message:'Choose named tags or untagged_only, not both.',path:['tags']}),list(currentRequirement)),
  tool('get_requirement','Read one current requirement, exact revision, system-maintained lifecycle dates and history coverage. Unknown dates remain explicit; lifecycle metadata is read-only.',z.strictObject({...project,requirement_id:reqId}),z.strictObject({...version,requirement:currentRequirement,lifecycle,coverage})),
  tool('get_requirement_history','Read durable history and lifecycle dates for an explicit project and current, deleted or pending requirement. Newest first; default 50, limit 1–100. Reuse all query arguments with next_cursor. INVALID_CURSOR requires a matching query; RESTART_REQUIRED means restart without a cursor after a concurrent write; NOT_FOUND means no known identity. Reads never backfill or mutate snapshots.',z.strictObject({...project,requirement_id:reqId,...page}),z.strictObject({...version,requirement_id:reqId,title:z.string(),current_revision:z.number().nullable(),current_status:status.nullable(),presence:z.enum(['current','deleted','absent','pending']),coverage,lifecycle,items:z.array(historyEvent),next_cursor:z.string().optional()})),
  tool('list_snapshots','List immutable snapshot metadata and separately recorded current implementation commit or null. Missing historical set versions are not inferred.',z.strictObject({...project,...page}),list(snapshot.omit({requirements:true,sections:true,repositories:true}).extend(implementationMetadata))),
  tool('get_snapshot','Read the exact frozen snapshot plus separate associations: proposals first included here and user-recorded implementation metadata. A commit does not establish implementation status or passing verification.',z.strictObject({...project,baseline_id:snapshotId}),z.strictObject({...version,snapshot,associations})),
  tool('get_snapshot_implementation_history','Read durable implementation commit corrections, newest first. Limit 1–100, default 50. Reuse all query arguments with next_cursor; restart after RESTART_REQUIRED. History is separate from frozen snapshot content.',z.strictObject({...project,baseline_id:snapshotId,...page}),z.strictObject({...version,baseline_id:snapshotId,...implementationMetadata,items:z.array(correction),next_cursor:z.string().optional()})),
  tool('set_snapshot_implementation','Record a user-supplied implementation reference on an existing snapshot. A non-null implementation_commit REPLACES the whole reference; omitted repository_id and commit_url are removed. Ordinary edits should preserve optional values. Use a full 40/64-character hexadecimal commit ID, optional same-project repository and credential-free HTTPS URL. Explicit null clears; omission is invalid. Does not change requirements, proposal inclusion, frozen exports or verification. Identical normalized values leave metadata time and workspace version unchanged. Reuse identical arguments and key after an uncertain response.',z.strictObject({...write,baseline_id:snapshotId,implementation_commit:implementationInput.nullable()}),z.strictObject({...version,baseline_id:snapshotId,...implementationMetadata,correlation_id:z.string()}),false),
  tool('list_proposals','List proposal summaries, review outcomes, change counts, and whether their bases are stale.',z.strictObject({...project,...page}),list(proposalSummary)),
  tool('get_proposal','Read a complete proposal with its base, staged requirements, field-level diff, and conflicting base/proposed/latest values.',z.strictObject({...project,proposal_id:proposalId}),z.strictObject({...version,proposal})),
  tool('create_proposal','Create a Draft against the current requirement set. Does not change current requirements. Requires the last-read workspace version and a retry key.',z.strictObject({...write,...proposalDetails}),mutation,false),
  tool('update_proposal','Update a Draft title and reason. Does not apply the proposal.',z.strictObject({...write,proposal_id:proposalId,...proposalDetails}),mutation,false),
  tool('stage_proposal_changes','Atomically stage 1–100 add/edit/delete/restore operations in a Draft. Edits preserve omitted tags and rich fields; [] clears collections. Additions default to requirement/plain_text. Exact source (description), ordered diagrams {id,language,source,title,alt,position in body code points}, summarizes {requirement_id,reviewed_revision?}, diagram_mappings {block_id,part,requirement_ids}. Markdown fences mermaid/dot/graphviz optionally use id=stable; fence source stays in description. New source links capture the final staged revision. $client_ref works in links, summarizes and mappings. Shared 50000-code-point content limit; request transport 250000 bytes. Invalid render syntax may be saved as Draft; submission blocks it. Current requirements remain unchanged.',z.strictObject({...write,proposal_id:proposalId,operations:z.array(operation).min(1).max(100)}),mutation,false),
  tool('submit_proposal','Submit a valid, nonempty, current Draft for human review. Applying remains in the Wonderworks UI.',z.strictObject({...write,proposal_id:proposalId}),mutation,false),
  tool('rebase_proposal','Refresh an open proposal onto the latest set. Supply proposed/latest for every conflicting requirement ID. Returns to Draft for fresh review.',z.strictObject({...write,proposal_id:proposalId,resolutions:z.record(reqId,z.enum(['proposed','latest']))}),mutation,false),
  tool('list_evidence','Read saved reports tied to exact frozen baselines. Old passing checks do not verify later revisions.',z.strictObject({...project,...page,baseline_id:snapshotId.optional()}),list(evidence)),
  tool('record_evidence','Record externally produced test/review outcomes against an existing baseline. Preserves failed checks and never changes requirement status.',z.strictObject({...write,evidence:evidenceInput}),mutation,false)
] as const;
export const toolMap=new Map(tools.map(t=>[t.name,t]));
