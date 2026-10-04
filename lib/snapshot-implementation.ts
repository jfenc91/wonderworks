import {z} from 'zod/v4';
import type {Workspace,ChangeProposal,HistoryActor,ImplementationCommit} from './types';
import {canonical} from './workflow';
import {ToolError} from './mcp/errors';

export const implementationInput=z.strictObject({
  commit_id:z.string().trim().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,'Use a full 40- or 64-character hexadecimal Git commit ID.'),
  repository_id:z.string().min(1).max(160).optional(),
  commit_url:z.string().trim().max(2048).regex(/^https:\/\//i,'Use an absolute HTTPS URL.').refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}},'Use an absolute HTTPS URL without credentials.').optional()
});
export function requireSnapshot(doc:Workspace,id:string){
  const snapshot=doc.baselines.find(b=>b.id===id);
  if(!snapshot)throw new ToolError('NOT_FOUND','Snapshot not found in this project. Check the project and snapshot IDs.');
  return snapshot;
}
export function implementationMetadata(doc:Workspace,id:string){
  const saved=doc.snapshotImplementations?.[id];
  return {implementation_commit:saved?.implementation_commit??null,implementation_updated_at:saved?.updated_at??null,implementation_actor:saved?.actor??null};
}
export function firstInclusion(doc:Workspace,p:ChangeProposal){
  const target=p.status==='Applied'&&p.appliedSnapshot?doc.baselines.find(b=>b.id===p.appliedSnapshot):undefined;
  return {
    state:p.status!=='Applied'?'not_yet_included' as const:target?'known' as const:'unknown' as const,
    snapshot:target?{id:target.id,name:target.name,requirements_version:target.requirementsVersion??p.appliedVersion??null}:null,
    original_snapshot_id:p.appliedSnapshot??null,
    ...(target?implementationMetadata(doc,target.id):{implementation_commit:null,implementation_updated_at:null,implementation_actor:null})
  };
}
export function snapshotAssociations(doc:Workspace,id:string){
  requireSnapshot(doc,id);
  return {...implementationMetadata(doc,id),first_included_proposals:(doc.proposals??[]).filter(p=>p.status==='Applied'&&p.appliedSnapshot===id).map(p=>({id:p.id,title:p.title,appliedVersion:p.appliedVersion??null}))};
}
// This mutates only live association metadata. Frozen baselines and proposals are never touched.
export function setSnapshotImplementation(doc:Workspace,id:string,input:unknown,actor:HistoryActor,date=new Date().toISOString()){
  requireSnapshot(doc,id);
  const parsed=implementationInput.nullable().safeParse(input);
  if(!parsed.success)throw new ToolError('VALIDATION_ERROR','Invalid implementation commit.',{fields:parsed.error.issues.map(i=>({path:i.path.join('.'),message:i.message}))});
  const old=doc.snapshotImplementations?.[id]?.implementation_commit??null;
  let next:ImplementationCommit|null=null;
  if(parsed.data){
    const data=parsed.data;
    next={...data,commit_id:data.commit_id.toLowerCase()};
    if(data.repository_id){
      // Retain captured identity/location when the same association is edited after a rename or removal.
      const repository=old?.repository_id===data.repository_id?old.repository:doc.repositories?.find(r=>r.id===data.repository_id);
      if(!repository)throw new ToolError('VALIDATION_ERROR','Repository is not linked to this project.',{repository_id:data.repository_id});
      next.repository=structuredClone(repository);
    }
  }
  if(canonical(old)===canonical(next))return false;
  const correction={id:crypto.randomUUID(),project_id:doc.id,baseline_id:id,date,actor:structuredClone(actor),before:structuredClone(old),after:structuredClone(next)};
  doc.snapshotImplementations??={};
  doc.snapshotImplementations[id]={implementation_commit:next,updated_at:date,actor:structuredClone(actor),history:[...(doc.snapshotImplementations[id]?.history??[]),correction]};
  return true;
}
