import {z} from 'zod/v4';
import {guidanceOverridesInput} from './agent-guidance';
import {canonical} from './workflow';
import {record} from './requirements';
import {digest,type Store,type Actor} from './mcp/service';
import {ToolError} from './mcp/errors';
export const guidanceSaveInput=z.strictObject({project_id:z.string().min(1),expected_workspace_version:z.number().int().nonnegative(),idempotency_key:z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),overrides:guidanceOverridesInput});
export async function saveGuidance(store:Store,raw:unknown,actor:Actor,now=Date.now()){
 const parsed=guidanceSaveInput.safeParse(raw);
 if(!parsed.success)throw new ToolError('VALIDATION_ERROR','Check the AI guidance settings.',{fields:parsed.error.issues.map(i=>({path:i.path.join('.'),message:i.message}))});
 const args=parsed.data,key=await digest({actor:actor.id,project:args.project_id,name:'save_agent_guidance',key:args.idempotency_key}),fingerprint=await digest(raw);
 const replay=await store.replay(key,fingerprint,now);if(replay)return replay;
 const doc=await store.read(args.project_id);
 if(doc.version!==args.expected_workspace_version)throw new ToolError('CONFLICT','Newer saved workspace available. Inspect the latest guidance and reconcile your pending values.',{current_workspace_version:doc.version});
 const unchanged=canonical(doc.agentGuidance?.overrides??{})===canonical(args.overrides);
 if(!unchanged){
  doc.agentGuidance={overrides:args.overrides,revision:(doc.agentGuidance?.revision??0)+1};
  record(doc,Object.keys(args.overrides).length?'Project AI guidance updated':'Project AI guidance restored to built-in defaults');
  doc.history[0].agentGuidance={revision:doc.agentGuidance.revision,actor:{id:actor.id}};
 }
 const result={...doc,version:doc.version+(unchanged?0:1)};
 return store.commit(doc,args.expected_workspace_version,{key,project:doc.id,fingerprint,result,expiresAt:now+86400000},now,unchanged);
}
