import {z} from 'zod/v4';
import {digest,type Store,type Actor} from './mcp/service';
import {ToolError} from './mcp/errors';
import {reconcileLifecycle,lifecycleState} from './lifecycle';
import {captureRequirementHistory} from './requirement-history';
import {record} from './requirements';
export const reconciliationInput=z.strictObject({project_id:z.string().min(1),expected_workspace_version:z.number().int().nonnegative(),idempotency_key:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)});
export async function reconcileProjectLifecycle(store:Store,raw:unknown,actor:Actor,now=Date.now()){
  const parsed=reconciliationInput.safeParse(raw);
  if(!parsed.success)throw new ToolError('VALIDATION_ERROR','Provide the exact project, workspace version and retry key.');
  const args=parsed.data,key=await digest({actor:actor.id,project:args.project_id,name:'reconcile_lifecycle',key:args.idempotency_key}),fingerprint=await digest(raw);
  const replay=await store.replay(key,fingerprint,now);if(replay)return replay;
  const doc=await store.read(args.project_id);if(doc.version!==args.expected_workspace_version)throw new ToolError('CONFLICT','Workspace changed. Read and reconcile before a new request.',{current_workspace_version:doc.version});
  const original=structuredClone(doc),{changed,affected}=reconcileLifecycle(doc);
  if(changed){record(doc,'Lifecycle reconciled from saved acceptance and snapshot commit records',affected.map(r=>r.requirement_id));doc.history[0].date=new Date(now).toISOString();captureRequirementHistory(original,doc,{source:'reconcile_lifecycle',actor:{id:actor.id,...(actor.clientName?{reportedClientName:actor.clientName}:{})},date:new Date(now).toISOString()});}
  const result={project_id:doc.id,workspace_version:doc.version+(changed?1:0),requirements_version:doc.requirementsVersion??1,affected_requirements:affected,lifecycle:doc.requirements.filter(r=>r.kind!=='information').map(r=>({requirement_id:r.id,...lifecycleState(doc,r)}))};
  return store.commit(doc,args.expected_workspace_version,{key,project:doc.id,fingerprint,result,expiresAt:now+86400000},now,!changed);
}
