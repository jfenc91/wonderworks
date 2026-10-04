import {z} from 'zod/v4';
import {normalizeTags,TAG_PATTERN} from '../tags';
const tagArray=z.array(z.string().max(100)).max(20).superRefine((value,ctx)=>{try{normalizeTags(value);}catch(error){ctx.addIssue({code:'custom',message:(error as Error).message});}});
const savedTags=z.array(z.string().min(1).max(40).regex(TAG_PATTERN)).max(20);
const inputTags=tagArray.optional().describe('Up to 20 labels, 100 raw characters each. Normalize to lowercase with spaces as hyphens; 1–40 letters/numbers/single hyphens. Omitted on edit preserves tags; [] clears.');

const text=z.string().min(1).max(160);
const reqId=z.string().regex(/^[A-Z]{2,6}-\d{3,6}$/);
const proposalId=z.string().regex(/^CP-\d+$/);
const snapshotId=z.string().regex(/^BL-\d+$/);
const status=z.enum(['Draft','Approved','Implemented']);
const requirementFields={
  section:z.string().min(1).max(80),title:z.string().trim().min(3).max(120),
  description:z.string().trim().min(10).max(4000),criteria:z.array(z.string().trim().min(3).max(1500)).min(1).max(20),
  priority:z.enum(['Critical','High','Medium']),status,
  parameters:z.record(z.string(),z.union([z.number().finite(),z.string().max(120),z.boolean()])),
  links:z.array(reqId).max(30),tags:savedTags.optional()
};
// Frozen imports retain their stored representation; only current reads synthesize canonical tags.
export const requirement=z.strictObject({...requirementFields,tags:tagArray.optional(),id:reqId,revision:z.number().int().positive()});
const currentRequirement=requirement.extend({tags:savedTags});
const requirementInput=z.strictObject({...requirementFields,tags:inputTags,parameters:requirementFields.parameters.default({}),links:requirementFields.links.default([])});
const section=z.strictObject({id:z.string(),title:z.string(),description:z.string()});
const repository=z.strictObject({id:z.string(),name:z.string(),url:z.string(),branch:z.string()});
const snapshot=z.strictObject({id:snapshotId,name:z.string(),date:z.string(),requirementsVersion:z.number().int().positive().optional(),repositories:z.array(repository).optional(),requirements:z.array(requirement),sections:z.array(section)});
const check=z.strictObject({id:reqId,title:z.string().max(500),passed:z.boolean(),detail:z.string().max(10000)});
export const evidenceInput=z.strictObject({baseline:snapshotId,artifactUrl:z.string().url().max(2000).refine(v=>['http:','https:'].includes(new URL(v).protocol)),summary:z.string().min(10).max(3000),checks:z.array(check).min(1).max(150)});
const evidence=evidenceInput.extend({id:text,date:z.string()});
const fields=z.enum(['section','title','description','criteria','priority','status','parameters','links','tags']);
const change=z.strictObject({id:reqId,before:requirement.optional(),after:requirement.optional(),kind:z.enum(['Added','Edited','Deleted']),fields:z.array(fields)});
const proposalSummary=z.strictObject({id:proposalId,title:z.string(),description:z.string(),status:z.enum(['Draft','Proposed','Applied','Rejected']),baseVersion:z.number().int(),createdAt:z.string(),updatedAt:z.string(),reviewNote:z.string().optional(),appliedVersion:z.number().int().optional(),appliedSnapshot:snapshotId.optional(),stale:z.boolean(),change_count:z.number().int()});
const proposal=proposalSummary.extend({baseRequirements:z.array(requirement),baseSections:z.array(section),requirements:z.array(requirement),changes:z.array(change),conflicts:z.array(z.strictObject({id:reqId,base:requirement.nullable(),proposed:requirement.nullable(),latest:requirement.nullable()}))});
const project={project_id:text.describe('Exact project ID returned by list_projects; never defaults to the selected browser project.')};
const page={limit:z.number().int().min(1).max(100).default(50),cursor:z.string().max(2000).optional()};
const write={...project,expected_workspace_version:z.number().int().nonnegative(),idempotency_key:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/).describe('Unique request key. Reuse with identical arguments after an uncertain result; retained for at least 24 hours.')};
const ref=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const link=z.union([reqId,z.string().regex(/^\$[A-Za-z][A-Za-z0-9_-]{0,63}$/)]).describe('An existing requirement ID or $client_ref for an addition in this batch.');
const stagedInput=requirementInput.extend({links:z.array(link).max(30).default([])});
const operation=z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('add'),client_ref:ref,requirement:stagedInput}),
  z.strictObject({op:z.literal('edit'),requirement_id:reqId,requirement:stagedInput}),
  z.strictObject({op:z.literal('delete'),requirement_id:reqId}),
  z.strictObject({op:z.literal('restore'),requirement_id:reqId})
]);
const version={...project,workspace_version:z.number().int(),requirements_version:z.number().int()};
const mutation=z.strictObject({...version,proposal_id:proposalId.optional(),status:z.enum(['Draft','Proposed']).optional(),client_refs:z.record(z.string(),reqId).optional(),evidence_id:text.optional(),baseline_id:snapshotId.optional(),date:z.string().optional(),correlation_id:z.string()});
const list=<T extends z.ZodType>(item:T)=>z.strictObject({...version,items:z.array(item),next_cursor:z.string().optional()});
const proposalDetails={title:z.string().trim().min(3).max(120),description:z.string().trim().max(3000).default('')};

function tool(name:string,description:string,input:z.ZodType,output:z.ZodType,readOnly=true){
  return {name,description,input,output,definition:{name,description,inputSchema:z.toJSONSchema(input,{io:'input'}),outputSchema:z.toJSONSchema(output),annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:true,openWorldHint:false}}};
}
export const tools=[
  tool('list_projects','List accessible projects and their workspace versions. Cursor pages are bound to the current project index.',z.strictObject(page),z.strictObject({items:z.array(z.strictObject({id:text,name:z.string(),workspace_version:z.number().int()})),next_cursor:z.string().optional()})),
  tool('get_project','Read identity, sections, repository links, and both workspace and requirement-set versions.',z.strictObject(project),z.strictObject({...version,id:text,name:z.string(),prefix:z.string(),sections:z.array(section),repositories:z.array(repository)})),
  tool('list_requirements','Read current requirements, including tags. Search includes tag labels. Exact tags match any (default) or all; untagged_only cannot combine with nonempty tags. All filters combine before pagination.',z.strictObject({...project,...page,query:z.string().max(500).optional(),section:z.string().max(80).optional(),status:status.optional(),tags:tagArray.default([]),tag_mode:z.enum(['any','all']).default('any'),untagged_only:z.boolean().default(false)}).refine(v=>!v.untagged_only||!v.tags.length,{message:'Choose named tags or untagged_only, not both.',path:['tags']}),list(currentRequirement)),
  tool('get_requirement','Read one current requirement with every saved field and its exact revision.',z.strictObject({...project,requirement_id:reqId}),z.strictObject({...version,requirement:currentRequirement})),
  tool('list_snapshots','List immutable snapshot metadata. Missing historical set versions are not inferred.',z.strictObject({...project,...page}),list(snapshot.omit({requirements:true,sections:true,repositories:true}))),
  tool('get_snapshot','Read the exact saved snapshot, including requirement revisions, sections, and repository links when present.',z.strictObject({...project,baseline_id:snapshotId}),z.strictObject({...version,snapshot})),
  tool('list_proposals','List proposal summaries, review outcomes, change counts, and whether their bases are stale.',z.strictObject({...project,...page}),list(proposalSummary)),
  tool('get_proposal','Read a complete proposal with its base, staged requirements, field-level diff, and conflicting base/proposed/latest values.',z.strictObject({...project,proposal_id:proposalId}),z.strictObject({...version,proposal})),
  tool('create_proposal','Create a Draft against the current requirement set. Does not change current requirements. Requires the last-read workspace version and a retry key.',z.strictObject({...write,...proposalDetails}),mutation,false),
  tool('update_proposal','Update a Draft title and reason. Does not apply the proposal.',z.strictObject({...write,proposal_id:proposalId,...proposalDetails}),mutation,false),
  tool('stage_proposal_changes','Atomically stage 1–100 add/edit/delete/restore operations in a Draft. Edit supplies requirement fields; omitted tags retain staged tags, [] clears, omitted on add means empty. Refer to batch additions using $client_ref in links. Current requirements remain unchanged.',z.strictObject({...write,proposal_id:proposalId,operations:z.array(operation).min(1).max(100)}),mutation,false),
  tool('submit_proposal','Submit a valid, nonempty, current Draft for human review. Applying remains in the Wonderworks UI.',z.strictObject({...write,proposal_id:proposalId}),mutation,false),
  tool('rebase_proposal','Refresh an open proposal onto the latest set. Supply proposed/latest for every conflicting requirement ID. Returns to Draft for fresh review.',z.strictObject({...write,proposal_id:proposalId,resolutions:z.record(reqId,z.enum(['proposed','latest']))}),mutation,false),
  tool('list_evidence','Read saved reports tied to exact frozen baselines. Old passing checks do not verify later revisions.',z.strictObject({...project,...page,baseline_id:snapshotId.optional()}),list(evidence)),
  tool('record_evidence','Record externally produced test/review outcomes against an existing baseline. Preserves failed checks and never changes requirement status.',z.strictObject({...write,evidence:evidenceInput}),mutation,false)
] as const;
export const toolMap=new Map(tools.map(t=>[t.name,t]));
