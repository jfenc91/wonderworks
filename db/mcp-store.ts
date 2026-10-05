import type {Workspace} from '../lib/types';
import {ToolError} from '../lib/mcp/errors';
import {readStoredRecord,prepareStoredRecord,prepareWorkspaceCommit,StoredRecordSession} from './workspace-records';

export type Receipt={key:string;project:string;fingerprint:string;result:Record<string,unknown>;expiresAt:number};
export class McpStore {
  private reads=new WeakMap<Workspace,StoredRecordSession>();
  constructor(private binding:D1Database|undefined){}
  private get db(){if(!this.binding)throw Error('Workspace storage unavailable');return this.binding;}
  async list(){
    const rows=await this.db.prepare('SELECT id,data,version FROM workspaces ORDER BY id').all<{id:string;data:string;version:number}>();
    return rows.results.map(row=>({id:row.id,name:JSON.parse(row.data).name as string,version:row.version}));
  }
  async read(id:string):Promise<Workspace>{
    const row=await this.db.prepare('SELECT data,version FROM workspaces WHERE id=?').bind(id).first<{data:string;version:number}>();
    if(!row)throw new ToolError('NOT_FOUND','Project not found or unavailable.');
    const records=new StoredRecordSession(this.db,id);
    let stored:Workspace;
    try{stored=await readStoredRecord<Workspace>(this.db,id,row.data,records);}
    catch(error){await this.requireLive(id);throw error;}
    const doc={...stored,id,version:row.version,requirementsVersion:stored.requirementsVersion??1,repositories:stored.repositories??[],proposals:stored.proposals??[]};
    this.reads.set(doc,records);return doc;
  }
  private async requireLive(id:string){
    if(!await this.db.prepare('SELECT id FROM workspaces WHERE id=?').bind(id).first())throw new ToolError('NOT_FOUND','Project not found or unavailable.');
  }
  async replay(key:string,fingerprint:string,now:number){
    const row=await this.db.prepare('SELECT project,fingerprint,result FROM mcp_receipts WHERE key=? AND expires_at>?').bind(key,now).first<{project:string;fingerprint:string;result:string}>();
    if(!row)return null;
    if(row.fingerprint!==fingerprint)throw new ToolError('IDEMPOTENCY_KEY_REUSED','This idempotency key was already used with different arguments.');
    try{return await readStoredRecord<Record<string,unknown>>(this.db,row.project,row.result);}
    catch(error){await this.requireLive(row.project);throw error;}
  }
  async commit(doc:Workspace,expected:number,receipt:Receipt,now:number,unchanged=false){
    // D1 batch is a transaction: INSERT and UPDATE see the same version and
    // either both persist or both roll back. A conflicting retry reads its receipt.
    // A normalized no-op still saves a durable receipt under the version gate,
    // but keeps the workspace version and its metadata timestamps unchanged.
    try{
      const nextDoc={...doc,version:expected+(unchanged?0:1)};
      const records=this.reads.get(doc)??new StoredRecordSession(this.db,doc.id);
      const prepared=await prepareWorkspaceCommit(this.db,doc.id,expected,nextDoc,records);
      const storedResult=await prepareStoredRecord(this.db,doc.id,receipt.result,records);
      const results=await this.db.batch([
        this.db.prepare('DELETE FROM mcp_receipts WHERE expires_at<=?').bind(now),
        this.db.prepare('INSERT INTO mcp_receipts (key,project,fingerprint,result,expires_at) SELECT ?,?,?,?,? FROM workspaces WHERE id=? AND version=?')
          .bind(receipt.key,doc.id,receipt.fingerprint,storedResult.data,receipt.expiresAt,doc.id,expected),
        prepared.backup,
        this.db.prepare('INSERT OR IGNORE INTO workspace_storage_versions(project,version,data,sha256,created_at) SELECT ?,?,?,?,? FROM workspaces WHERE id=? AND version=?')
          .bind(doc.id,nextDoc.version,prepared.next.data,prepared.next.sha256,new Date(now).toISOString(),doc.id,expected),
        this.db.prepare('UPDATE workspaces SET data=?,version=? WHERE id=? AND version=?')
          .bind(prepared.next.data,nextDoc.version,doc.id,expected)
      ]);
      if(results.at(-1)!.meta.changes===1)return receipt.result;
    }catch(error){
      await this.requireLive(doc.id);
      // Diagnose storage limits without logging workspace content or credentials.
      const message=String(error instanceof Error?error.message:error)+' '+String((error as {cause?:{message?:string}})?.cause?.message??'');
      console.error(JSON.stringify({event:'workspace_commit_failure',bytes:new TextEncoder().encode(JSON.stringify(doc)).length,reason:/too big|TOOBIG/i.test(message)?'value_too_large':/too many|limit/i.test(message)?'storage_limit':/constraint|UNIQUE/i.test(message)?'constraint':/locked|busy/i.test(message)?'busy':'unclassified',code:message.match(/\b(?:SQLITE|D1)_[A-Z_]+\b/g)??[],errorName:error instanceof Error?error.name:'unknown'}));
      const replay=await this.replay(receipt.key,receipt.fingerprint,now);
      if(replay)return replay;
      if(error instanceof Error&&error.message==='CONFLICT')throw new ToolError('CONFLICT','Workspace changed. Reload the project before making a new write.',{current_workspace_version:(await this.read(doc.id)).version});
      throw error;
    }
    const replay=await this.replay(receipt.key,receipt.fingerprint,now);
    if(replay)return replay;
    const latest=await this.read(doc.id);
    throw new ToolError('CONFLICT','Workspace changed. Reload the project before making a new write.',{current_workspace_version:latest.version});
  }
}
