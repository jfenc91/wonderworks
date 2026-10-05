import {database} from '@/db/runtime';
import seed from '@/data/workspace.json';
import type {Workspace} from '@/lib/types';
import {readStoredRecord,prepareStoredRecord,prepareWorkspaceCommit,StoredRecordSession} from './workspace-records';
import {rejectDeletedId} from './workspace-deletion';
const reads=new WeakMap<Workspace,StoredRecordSession>();
async function ensureSeed(db:D1Database){await db.prepare('INSERT OR IGNORE INTO workspaces (id,data,version) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM workspace_deletions WHERE project=?)').bind('asteroids',JSON.stringify(seed),seed.version,'asteroids').run();}
// Version polling and project selectors need only the small root envelope.
export async function readWorkspaceVersion(id:string){return (await database().prepare('SELECT version FROM workspaces WHERE id=?').bind(id).first<{version:number}>())?.version??null;}
export async function readWorkspace(id='asteroids'):Promise<Workspace>{
 const db=database();
 await ensureSeed(db);
 const row=await db.prepare('SELECT data,version FROM workspaces WHERE id=?').bind(id).first<{data:string;version:number}>();if(!row)throw new Error('Workspace not found');
 const records=new StoredRecordSession(db,id);
 let d:Workspace;
 try{d=await readStoredRecord<Workspace>(db,id,row.data,records);}
 catch(error){if(await readWorkspaceVersion(id)===null)throw Error('Workspace not found');throw error;}
 const doc={...d,id,prefix:d.prefix??'AST',baselines:d.baselines??[],evidence:d.evidence??[],repositories:d.repositories??[],proposals:d.proposals??[],requirementsVersion:d.requirementsVersion??1,version:row.version};
 reads.set(doc,records);return doc;
}
export async function saveWorkspace(doc:Workspace,expected:number){
 try{
 const db=database(),next={...doc,version:expected+1},prepared=await prepareWorkspaceCommit(db,doc.id,expected,next,reads.get(doc));
 const results=await db.batch([prepared.backup,
  db.prepare('INSERT OR IGNORE INTO workspace_storage_versions(project,version,data,sha256,created_at) SELECT ?,?,?,?,? FROM workspaces WHERE id=? AND version=?').bind(doc.id,next.version,prepared.next.data,prepared.next.sha256,new Date().toISOString(),doc.id,expected),
  db.prepare('UPDATE workspaces SET data=?,version=? WHERE id=? AND version=?').bind(prepared.next.data,next.version,doc.id,expected)
 ]);
 if(results.at(-1)!.meta.changes!==1)throw Error('CONFLICT');return next;
 }catch(error){
  // Deletion can remove the immutable records between a read and a staged
  // save. Report the terminal project state instead of a storage failure.
  const current=await readWorkspaceVersion(doc.id);
  if(current===null)throw Error('Workspace not found');
  if(current!==expected)throw Error('CONFLICT');
  throw error;
 }
}
export async function listWorkspaces(){const db=database();await ensureSeed(db);const rows=await db.prepare('SELECT id,data FROM workspaces').all<{id:string;data:string}>();return rows.results.map(r=>({id:r.id,name:JSON.parse(r.data).name}));}
export async function createWorkspace(name:string,prefix:string){
 const id=crypto.randomUUID(),db=database();
 const doc:Workspace={id,prefix,name,version:0,requirementsVersion:1,repositories:[],proposals:[],sections:[],requirements:[],baselines:[],evidence:[],history:[{id:crypto.randomUUID(),date:new Date().toISOString(),message:'Project created · '+name}]};
 const stored=await prepareStoredRecord(db,id,doc);
 await db.batch([
  rejectDeletedId(db,id),
  db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,0)').bind(id,stored.data),
  db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,created_at) VALUES(?,0,?,?,?)').bind(id,stored.data,stored.sha256,new Date().toISOString())
 ]);return doc;
}
