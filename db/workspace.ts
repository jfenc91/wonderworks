import {env} from 'cloudflare:workers';
import seed from '@/data/workspace.json';
import type {Workspace} from '@/lib/types';
import {readStoredRecord,prepareStoredRecord,prepareWorkspaceCommit} from './workspace-records';
function database(){if(!env.DB)throw new Error('Workspace storage is unavailable');return env.DB;}
// Version polling and project selectors need only the small root envelope.
export async function readWorkspaceVersion(id:string){return (await database().prepare('SELECT version FROM workspaces WHERE id=?').bind(id).first<{version:number}>())?.version??null;}
export async function readWorkspace(id='asteroids'):Promise<Workspace>{
 const db=database();
 await db.prepare('INSERT OR IGNORE INTO workspaces (id,data,version) VALUES (?,?,?)').bind('asteroids',JSON.stringify(seed),seed.version).run();
 const row=await db.prepare('SELECT data,version FROM workspaces WHERE id=?').bind(id).first<{data:string;version:number}>();if(!row)throw new Error('Workspace not found');
 const d=await readStoredRecord<Workspace>(db,id,row.data);
 return {...d,id,prefix:d.prefix??'AST',baselines:d.baselines??[],evidence:d.evidence??[],repositories:d.repositories??[],proposals:d.proposals??[],requirementsVersion:d.requirementsVersion??1,version:row.version};
}
export async function saveWorkspace(doc:Workspace,expected:number){
 const db=database(),next={...doc,version:expected+1},prepared=await prepareWorkspaceCommit(db,doc.id,expected,next);
 const results=await db.batch([prepared.backup,
  db.prepare('INSERT OR IGNORE INTO workspace_storage_versions(project,version,data,sha256,created_at) SELECT ?,?,?,?,? FROM workspaces WHERE id=? AND version=?').bind(doc.id,next.version,prepared.next.data,prepared.next.sha256,new Date().toISOString(),doc.id,expected),
  db.prepare('UPDATE workspaces SET data=?,version=? WHERE id=? AND version=?').bind(prepared.next.data,next.version,doc.id,expected)
 ]);
 if(results.at(-1)!.meta.changes!==1)throw Error('CONFLICT');return next;
}
export async function listWorkspaces(){await readWorkspace();const rows=await database().prepare('SELECT id,data FROM workspaces').all<{id:string;data:string}>();return rows.results.map(r=>({id:r.id,name:JSON.parse(r.data).name}));}
export async function createWorkspace(name:string,prefix:string){
 const id=crypto.randomUUID(),db=database();
 const doc:Workspace={id,prefix,name,version:0,requirementsVersion:1,repositories:[],proposals:[],sections:[],requirements:[],baselines:[],evidence:[],history:[{id:crypto.randomUUID(),date:new Date().toISOString(),message:'Project created · '+name}]};
 const stored=await prepareStoredRecord(db,id,doc);
 await db.batch([
  db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,0)').bind(id,stored.data),
  db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,created_at) VALUES(?,0,?,?,?)').bind(id,stored.data,stored.sha256,new Date().toISOString())
 ]);return doc;
}
