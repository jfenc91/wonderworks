import {sha256} from './workspace-records';

export type DeletionRecord={project:string;actor:string;key:string;fingerprint:string;version:number;deleted_at:string;expires_at:number};
export class DeletionError extends Error {
  constructor(message:string,readonly status:number,readonly version?:number){super(message);}
}
export const deletionColumns='project,actor,key,fingerprint,version,deleted_at,expires_at';
export function deletionResult(row:DeletionRecord){return {deleted:true,project_id:row.project,workspace_version:row.version,deleted_at:row.deleted_at};}
// Fails the entire publication batch if an ID has been permanently reserved.
// Works on D1/SQLite and PostgreSQL without backend-specific trigger syntax.
export function rejectDeletedId(db:D1Database,id:string){return db.prepare(`INSERT INTO workspace_deletions(${deletionColumns}) SELECT ${deletionColumns} FROM workspace_deletions WHERE project=?`).bind(id);}

export async function deleteWorkspace(db:D1Database,input:{project_id:string;expected_workspace_version:number;idempotency_key:string},actor:string){
  const key=await sha256(JSON.stringify({actor,project:input.project_id,key:input.idempotency_key}));
  const fingerprint=await sha256(JSON.stringify(input));
  async function replay(){
    const row=await db.prepare(`SELECT ${deletionColumns} FROM workspace_deletions WHERE project=?`).bind(input.project_id).first<DeletionRecord>();
    if(!row)return null;
    if(row.actor===actor&&row.key===key&&Number(row.expires_at)>Date.now()){
      if(row.fingerprint!==fingerprint)throw new DeletionError('This retry key was used with different deletion details.',409);
      return deletionResult(row);
    }
    throw new DeletionError('Project not found or unavailable.',404);
  }
  const prior=await replay();if(prior)return prior;
  const version=await db.prepare('SELECT version FROM workspaces WHERE id=?').bind(input.project_id).first<{version:number}>();
  if(!version){const raced=await replay();if(raced)return raced;throw new DeletionError('Project not found or unavailable.',404);}
  if(version.version!==input.expected_workspace_version)throw new DeletionError('The workspace changed. Review its current contents and confirm deletion again.',409,version.version);
  const row:DeletionRecord={project:input.project_id,actor,key,fingerprint,version:version.version+1,deleted_at:new Date().toISOString(),expires_at:Date.now()+86400000};
  try{
    const results=await db.batch([
      db.prepare(`INSERT INTO workspace_deletions(${deletionColumns}) SELECT ?,?,?,?,?,?,? FROM workspaces WHERE id=? AND version=?`).bind(row.project,row.actor,row.key,row.fingerprint,row.version,row.deleted_at,row.expires_at,row.project,version.version),
      ...['workspace_provenance','mcp_receipts','workspace_storage_versions','workspace_records'].map(table=>db.prepare(`DELETE FROM ${table} WHERE project=? AND EXISTS(SELECT 1 FROM workspace_deletions WHERE project=? AND key=?)`).bind(row.project,row.project,key)),
      db.prepare('DELETE FROM workspaces WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM workspace_deletions WHERE project=? AND key=?)').bind(row.project,version.version,row.project,key)
    ]);
    if(results.at(-1)!.meta.changes===1)return deletionResult(row);
  }catch(error){const saved=await replay();if(saved)return saved;throw error;}
  const saved=await replay();if(saved)return saved;
  const latest=await db.prepare('SELECT version FROM workspaces WHERE id=?').bind(row.project).first<{version:number}>();
  throw new DeletionError('The workspace changed. Review its current contents and confirm deletion again.',409,latest?.version);
}
