import {z} from 'zod/v4';
import {ZodError} from 'zod';
import {operation} from './mcp/contracts';
import {digest,stage,type Store,type Actor} from './mcp/service';
import {ToolError} from './mcp/errors';
import {createProposal,getProposal} from './workflow';
import {captureRequirementHistory} from './requirement-history';
import {record} from './requirements';

export const authoringInput=z.strictObject({
  project_id:z.string().min(1),expected_workspace_version:z.number().int().nonnegative(),
  idempotency_key:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  proposal_id:z.string().regex(/^CP-\d+$/).optional(),
  new_proposal:z.strictObject({title:z.string().trim().min(3).max(120),description:z.string().trim().max(3000).default('')}).optional(),
  operations:z.array(operation).min(1).max(100)
}).refine(v=>!!v.proposal_id!==!!v.new_proposal,{message:'Choose one Draft proposal or provide a new proposal title.'});

// Creation, staging, identity allocation, history, and the retry receipt share
// one compare-and-swap transaction. Validation only touches the detached copy.
export async function authorRequirements(store:Store,raw:unknown,actor:Actor,now=Date.now()){
  const parsed=authoringInput.safeParse(raw);
  if(!parsed.success)throw new ToolError('VALIDATION_ERROR',parsed.error.issues.map(i=>i.message).join('; '));
  const args=parsed.data;
  const key=await digest({actor:actor.id,project:args.project_id,name:'author_requirements',key:args.idempotency_key});
  const fingerprint=await digest(raw),replay=await store.replay(key,fingerprint,now);
  if(replay)return replay;
  const doc=await store.read(args.project_id);
  if(doc.version!==args.expected_workspace_version)throw new ToolError('CONFLICT','Newer saved changes are available. Compare the latest source and destination before saving your pending input.',{current_workspace_version:doc.version});
  const original=structuredClone(doc);
  try{
    const p=args.new_proposal?createProposal(doc,args.new_proposal):getProposal(doc,args.proposal_id!,true);
    const refs=stage(doc,p.id,args.operations);
    doc.history=structuredClone(original.history);
    record(doc,`Requirements staged in ${p.id} · ${p.title}`,[...Object.values(refs),...args.operations.flatMap(op=>'requirement_id' in op?[op.requirement_id]:[])]);
    captureRequirementHistory(original,doc,{source:'proposal_authoring',actor:{id:actor.id}});
  }catch(error){
    if(error instanceof ToolError)throw error;
    if(error instanceof ZodError)throw new ToolError('VALIDATION_ERROR',error.issues.map(i=>i.message).join('; '));
    throw new ToolError('VALIDATION_ERROR',error instanceof Error?error.message:'Invalid staged change.');
  }
  const result={...doc,version:doc.version+1};
  return store.commit(doc,args.expected_workspace_version,{key,project:doc.id,fingerprint,result,expiresAt:now+86400000},now);
}
