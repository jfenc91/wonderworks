import {archiveWorkspace,archiveOperations,archiveDeletions,payload,projectRecords,checkAbort,type Archive} from '../lib/workspace-archive';
import {rejectDeletedId,deletionColumns} from './workspace-deletion';
import {prepareStoredRecord,sha256} from './workspace-records';
export type ImportSelection={id:string;mode:'restore'|'copy'};
type ImportResult={projects:{id:string;source_id:string;name:string;version:number;mode:string}[];archive_id:string;imported_at:string};
export async function previewArchive(db:D1Database,archive:Archive){
  const existing=new Set((await db.prepare('SELECT id FROM workspaces').all<{id:string}>()).results.map(p=>p.id));
  const deleted=new Set((await db.prepare('SELECT project FROM workspace_deletions').all<{project:string}>()).results.map(p=>p.project));
  return {archive_id:archive.manifest.id,fingerprint:archive.fingerprint,producer:archive.manifest.producer,created_at:archive.manifest.createdAt,projects:archive.manifest.projects.map(p=>{const doc=archiveWorkspace(archive,p);return {...p,conflict:existing.has(p.id)||deleted.has(p.id),deleted:deleted.has(p.id),items:doc.requirements.length,proposals:doc.proposals?.length??0,snapshots:doc.baselines.length,history_events:Object.values(doc.requirementHistory??{}).reduce((n,r)=>n+r.events.length,0)};}),warnings:['Historical approvals, actors and verification remain imported provenance. Unknown legacy fields are preserved.','Copy mode retains source retry history as metadata; source receipts cannot authorize destination mutations.']};
}
export async function importArchive(db:D1Database,archive:Archive,selections:ImportSelection[],actor:string,operation:string,signal?:AbortSignal,{emptyOnly=false}={}){
  if(!actor||!/^[A-Za-z0-9_-]{16,128}$/.test(operation)||!Array.isArray(selections)||(!selections.length&&!(emptyOnly&&archiveDeletions(archive).length))||selections.length>50||new Set(selections.map(s=>s.id)).size!==selections.length||selections.some(s=>!['restore','copy'].includes(s.mode)||!archive.manifest.projects.some(p=>p.id===s.id)))throw Error('Select archived projects, a restore/copy mode, and a durable operation ID.');
  const key=await sha256(JSON.stringify({actor,operation})),fingerprint=await sha256(JSON.stringify({archive:archive.fingerprint,selections,emptyOnly}));
  async function replay(){const row=await db.prepare('SELECT actor,fingerprint,result FROM workspace_imports WHERE key=?').bind(key).first<{actor:string;fingerprint:string;result:string}>();if(!row)return null;if(row.actor!==actor||row.fingerprint!==fingerprint)throw Error('Import operation ID was already used for a different archive or selection.');const result=JSON.parse(row.result) as ImportResult;for(const p of result.projects)if(!(await db.prepare('SELECT id FROM workspaces WHERE id=?').bind(p.id).first()))throw Error('A destination project was deleted or is unavailable. Review the project list before another import.');return result;}
  const saved=await replay();if(saved)return saved;
  const initial=await db.prepare('SELECT id FROM workspaces').all<{id:string}>();const deleted=(await db.prepare('SELECT project FROM workspace_deletions').all<{project:string}>()).results;
  if(emptyOnly&&(initial.results.length||deleted.length))throw Error('Administrative restore requires an empty destination.');
  if(selections.some(s=>s.mode==='restore'&&(initial.results.some(p=>p.id===s.id)||deleted.some(p=>p.project===s.id))))throw Error('A destination project already exists or its ID is reserved after deletion. Skip it or choose import as a copy.');
  const result:ImportResult={projects:[],archive_id:archive.manifest.id,imported_at:new Date().toISOString()},statements:D1PreparedStatement[]=[];
  const shadows:string[]=[];
  try{
    for(const selection of selections){
      checkAbort(signal);const project=archive.manifest.projects.find(p=>p.id===selection.id)!,source=payload(archive,project),doc=archiveWorkspace(archive,project);
      const identity=await sha256(key+':'+project.id),destination=selection.mode==='restore'?project.id:`${identity.slice(0,8)}-${identity.slice(8,12)}-4${identity.slice(13,16)}-a${identity.slice(17,20)}-${identity.slice(20,32)}`;
      // A request-specific staging namespace is never visible in project reads.
      // Simultaneous retries can stage independently; the receipt/root batch
      // chooses one outcome, and the loser reads that durable result.
      const shadow='import-'+crypto.randomUUID();shadows.push(shadow);
      const records=[...projectRecords(archive,project)];
      for(let i=0;i<records.length;i+=20){checkAbort(signal);await db.batch(records.slice(i,i+20).map(([hash,data])=>db.prepare('INSERT OR IGNORE INTO workspace_records(project,hash,data) VALUES(?,?,?)').bind(shadow,hash,data)));}
      let data=source.workspace.data;
      if(selection.mode==='copy'){data=(await prepareStoredRecord(db,shadow,{...doc,id:destination})).data;}
      for(let i=0;i<source.versions.length;i+=20){checkAbort(signal);await db.batch(source.versions.slice(i,i+20).map(v=>db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,legacy_data,created_at) VALUES(?,?,?,?,?,?)').bind(shadow,v.version,v.data,v.sha256,v.legacy_data,v.created_at)));}
      if(selection.mode==='restore')for(let i=0;i<source.receipts.length;i+=20){checkAbort(signal);await db.batch(source.receipts.slice(i,i+20).filter(r=>r.expires_at>Date.now()).map(r=>db.prepare('INSERT INTO mcp_receipts(key,project,fingerprint,result,expires_at) VALUES(?,?,?,?,?)').bind(shadow+':'+r.key,shadow,r.fingerprint,r.result,r.expires_at)));}
      const provenance=await prepareStoredRecord(db,shadow,{source_archive:archive.manifest.id,source_project:project.id,source_version:project.version,mode:selection.mode,imported_at:result.imported_at,imported_by:actor,prior:source.provenance??null,...(selection.mode==='copy'?{inactive_source_receipts:source.receipts}:{}),historical_assertions:'Imported provenance; not locally performed approvals or verification.'});
      statements.push(
        rejectDeletedId(db,destination),
        db.prepare('INSERT INTO workspaces(id,data,version) VALUES(?,?,?)').bind(destination,data,project.version),
        db.prepare('INSERT OR IGNORE INTO workspace_records(project,hash,data) SELECT ?,hash,data FROM workspace_records WHERE project=?').bind(destination,shadow),
        db.prepare('INSERT INTO workspace_storage_versions(project,version,data,sha256,legacy_data,created_at) SELECT ?,version,data,sha256,legacy_data,created_at FROM workspace_storage_versions WHERE project=?').bind(destination,shadow),
        db.prepare('INSERT INTO mcp_receipts(key,project,fingerprint,result,expires_at) SELECT substr(key,?),?,fingerprint,result,expires_at FROM mcp_receipts WHERE project=?').bind(shadow.length+2,destination,shadow),
        db.prepare('INSERT INTO workspace_provenance(project,data) VALUES(?,?)').bind(destination,provenance.data)
      );
      result.projects.push({id:destination,source_id:project.id,name:doc.name,version:project.version,mode:selection.mode});
    }
    // Administrative restoration is explicitly offline/empty. The SQL guard
    // prevents a concurrent project creation from silently violating emptiness.
    if(emptyOnly){statements.unshift(db.prepare('INSERT INTO workspaces(id,data,version) SELECT id,data,version FROM workspaces LIMIT 1'),db.prepare(`INSERT INTO workspace_deletions(${deletionColumns}) SELECT ${deletionColumns} FROM workspace_deletions LIMIT 1`));
      for(const d of archiveDeletions(archive))statements.push(db.prepare(`INSERT INTO workspace_deletions(${deletionColumns}) VALUES(?,?,?,?,?,?,?)`).bind(d.project,d.actor,d.key,d.fingerprint,d.version,d.deleted_at,d.expires_at));
    }
    const restored=new Set(selections.filter(s=>s.mode==='restore').map(s=>s.id));
    for(const op of archiveOperations(archive)){
      let previous;try{previous=JSON.parse(op.result);}catch{throw Error('Invalid archived import receipt.');}
      if(!/^[a-f0-9]{64}$/.test(op.key)||!/^[a-f0-9]{64}$/.test(op.fingerprint)||typeof op.actor!=='string'||!Array.isArray(previous.projects))throw Error('Invalid archived import receipt scope.');
      if(previous.projects.every((p:{id:string})=>restored.has(p.id)))statements.push(db.prepare('INSERT OR IGNORE INTO workspace_imports(key,actor,fingerprint,result,created_at) VALUES(?,?,?,?,?)').bind(op.key,op.actor,op.fingerprint,op.result,op.created_at));
    }
    statements.push(db.prepare('INSERT INTO workspace_imports(key,actor,fingerprint,result,created_at) VALUES(?,?,?,?,?)').bind(key,actor,fingerprint,JSON.stringify(result),result.imported_at));
    checkAbort(signal);await db.batch(statements);return result;
  }catch(error){const receipt=await replay();if(receipt)return receipt;throw error;}
  finally{
    // Failed/aborted staging is unreachable and safe to clean. Cleanup failure
    // cannot undo a successful publication or obscure its durable retry result.
    for(const shadow of shadows)await db.batch(['workspace_records','workspace_storage_versions','mcp_receipts'].map(table=>db.prepare(`DELETE FROM ${table} WHERE project=?`).bind(shadow))).catch(()=>{});
  }
}
