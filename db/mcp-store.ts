import type {Workspace} from '../lib/types';
import {ToolError} from '../lib/mcp/errors';
import {encodeWorkspace,decodeWorkspace,encodeStoredRecord,decodeStoredRecord} from './workspace-codec';

export type Receipt={key:string;project:string;fingerprint:string;result:Record<string,unknown>;expiresAt:number};
export class McpStore {
  constructor(private binding:D1Database|undefined){}
  private get db(){if(!this.binding)throw Error('Workspace storage unavailable');return this.binding;}
  async list(){
    const rows=await this.db.prepare('SELECT id,data,version FROM workspaces ORDER BY id').all<{id:string;data:string;version:number}>();
    return rows.results.map(row=>({id:row.id,name:JSON.parse(row.data).name as string,version:row.version}));
  }
  async read(id:string):Promise<Workspace>{
    const row=await this.db.prepare('SELECT data,version FROM workspaces WHERE id=?').bind(id).first<{data:string;version:number}>();
    if(!row)throw new ToolError('NOT_FOUND','Project not found or unavailable.');
    const doc=await decodeWorkspace(row.data);
    return {...doc,id,version:row.version,requirementsVersion:doc.requirementsVersion??1,repositories:doc.repositories??[],proposals:doc.proposals??[]};
  }
  async replay(key:string,fingerprint:string,now:number){
    const row=await this.db.prepare('SELECT fingerprint,result FROM mcp_receipts WHERE key=? AND expires_at>?').bind(key,now).first<{fingerprint:string;result:string}>();
    if(!row)return null;
    if(row.fingerprint!==fingerprint)throw new ToolError('IDEMPOTENCY_KEY_REUSED','This idempotency key was already used with different arguments.');
    return decodeStoredRecord<Record<string,unknown>>(row.result);
  }
  async commit(doc:Workspace,expected:number,receipt:Receipt,now:number,unchanged=false){
    // D1 batch is a transaction: INSERT and UPDATE see the same version and
    // either both persist or both roll back. A conflicting retry reads its receipt.
    // A normalized no-op still saves a durable receipt under the version gate,
    // but keeps the workspace version and its metadata timestamps unchanged.
    try{
      const results=await this.db.batch([
        this.db.prepare('DELETE FROM mcp_receipts WHERE expires_at<=?').bind(now),
        this.db.prepare('INSERT INTO mcp_receipts (key,project,fingerprint,result,expires_at) SELECT ?,?,?,?,? FROM workspaces WHERE id=? AND version=?')
          .bind(receipt.key,doc.id,receipt.fingerprint,await encodeStoredRecord(receipt.result),receipt.expiresAt,doc.id,expected),
        this.db.prepare('UPDATE workspaces SET data=?,version=? WHERE id=? AND version=?')
          .bind(await encodeWorkspace({...doc,version:expected+(unchanged?0:1)}),expected+(unchanged?0:1),doc.id,expected)
      ]);
      if(results[2].meta.changes===1)return receipt.result;
    }catch(error){
      // Diagnose storage limits without logging workspace content or credentials.
      const message=String(error instanceof Error?error.message:error)+' '+String((error as {cause?:{message?:string}})?.cause?.message??'');
      console.error(JSON.stringify({event:'workspace_commit_failure',bytes:new TextEncoder().encode(JSON.stringify(doc)).length,reason:/too big|TOOBIG/i.test(message)?'value_too_large':/too many|limit/i.test(message)?'storage_limit':/constraint|UNIQUE/i.test(message)?'constraint':/locked|busy/i.test(message)?'busy':'unclassified',code:message.match(/\b(?:SQLITE|D1)_[A-Z_]+\b/g)??[],errorName:error instanceof Error?error.name:'unknown'}));
      const replay=await this.replay(receipt.key,receipt.fingerprint,now);
      if(replay)return replay;
      throw error;
    }
    const replay=await this.replay(receipt.key,receipt.fingerprint,now);
    if(replay)return replay;
    const latest=await this.read(doc.id);
    throw new ToolError('CONFLICT','Workspace changed. Reload the project before making a new write.',{current_workspace_version:latest.version});
  }
}
