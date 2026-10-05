import {Zip,ZipPassThrough,deflateSync,Unzip,UnzipInflate} from 'fflate';
import {buildGraph,materialize,parseNode,references,sha256,RECORD_ENCODING,type Node} from '../db/workspace-records';
import type {DeletionRecord} from '../db/workspace-deletion';
import type {Workspace,Requirement,Section} from './types';
import {validateDependencies} from './requirements';
import {validateReferences} from './item-content';
import {validateArchiveDirectory,validateArchiveDownload} from './archive-download.mjs';

export const ARCHIVE_VERSION=1;
export const ARCHIVE_LIMITS={compressed:32*1024*1024,expanded:64*1024*1024,records:10000,projects:50,depth:64,manifest:2*1024*1024,workspace:32*1024*1024};
type StoredRow={data:string;version:number;id:string};
export type ArchiveProject={id:string;name:string;version:number;requirementsVersion?:number;root:string};
export type ArchiveManifest={format:'wonderworks.workspace';version:1|2;storage:typeof RECORD_ENCODING;producer:string;id:string;createdAt:string;projects:ArchiveProject[];records:{hash:string;bytes:number}[];expandedBytes:number;operations?:string;deletions?:string};
export type Archive={manifest:ArchiveManifest;records:Map<string,string>;fingerprint:string};
export type ProjectPayload={workspace:StoredRow;versions:{project:string;version:number;data:string;sha256:string;legacy_data:string|null;created_at:string}[];receipts:{key:string;project:string;fingerprint:string;result:string;expires_at:number}[];provenance?:unknown};
const bytes=(s:string)=>new TextEncoder().encode(s);
const hashPattern=/^[a-f0-9]{64}$/;
const projectPattern=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw Error('Transfer cancelled.');}
function jsonDepth(value:unknown,depth=0){if(depth>ARCHIVE_LIMITS.depth)throw Error('Archive nesting limit exceeded.');if(value&&typeof value==='object')for(const v of Object.values(value))jsonDepth(v,depth+1);}
function unique(values:string[],label:string){if(values.some(v=>typeof v!=='string'||!v)||new Set(values).size!==values.length)throw Error('Invalid or duplicate '+label);}
function validateItems(items:Requirement[],sections:Section[]){
  if(!Array.isArray(items)||!Array.isArray(sections))throw Error('Missing specification content.');
  unique(sections.map(s=>s.id),'section IDs');unique(items.map(r=>r.id),'item IDs');
  const ids=new Set(items.map(r=>r.id));
  for(const r of items)if(!/^[A-Z]{2,6}-\d{3,6}$/.test(r.id)||!Number.isSafeInteger(r.revision)||r.revision<1||typeof r.title!=='string'||typeof r.description!=='string'||!Array.isArray(r.criteria)||r.criteria.some(c=>typeof c!=='string')||!Array.isArray(r.links)||r.links.some(id=>!ids.has(id))||!sections.some(s=>s.id===r.section)||!r.parameters||!['Draft','Approved','Implemented'].includes(r.status))throw Error('Invalid requirement or missing section/dependency.');
  validateDependencies({requirements:items} as Workspace);validateReferences(items);
}
// Validation never returns a schema-normalized copy: missing legacy keys and
// unknown additive fields survive byte-for-byte in their original records.
export function validateWorkspace(value:unknown):asserts value is Workspace{
  jsonDepth(value);const w=value as Workspace;
  if(!w||!projectPattern.test(w.id)||typeof w.name!=='string'||!w.name||!/^[A-Z]{2,6}$/.test(w.prefix)||!Number.isSafeInteger(w.version)||w.version<0||!Array.isArray(w.baselines)||!Array.isArray(w.evidence)||!Array.isArray(w.history))throw Error('Invalid workspace identity, versions or history.');
  validateItems(w.requirements,w.sections);
  unique(w.baselines.map(b=>b.id),'snapshot IDs');unique((w.proposals??[]).map(p=>p.id),'proposal IDs');unique(w.evidence.map(e=>e.id),'evidence IDs');
  for(const b of w.baselines)validateItems(b.requirements,b.sections);
  for(const p of w.proposals??[]){
    if(!['Draft','Proposed','Applied','Rejected'].includes(p.status)||!Number.isSafeInteger(p.baseVersion))throw Error('Invalid proposal state.');
    validateItems(p.baseRequirements,p.baseSections);
    // Saved pending proposals may reference older sections, retained in base.
    validateItems(p.requirements,[...w.sections,...p.baseSections.filter(s=>!w.sections.some(t=>t.id===s.id))]);
    if(p.appliedSnapshot&&!w.baselines.some(b=>b.id===p.appliedSnapshot))throw Error('Missing applied snapshot.');
  }
  for(const e of w.evidence){const b=w.baselines.find(b=>b.id===e.baseline);if(!b||!Array.isArray(e.checks)||e.checks.some(c=>!b.requirements.some(r=>r.id===c.id)||typeof c.passed!=='boolean'))throw Error('Invalid evidence reference.');}
  for(const [id,record] of Object.entries(w.requirementHistory??{})){
    if(typeof record.complete!=='boolean'||!Array.isArray(record.events))throw Error('Invalid history coverage.');
    unique(record.events.map(e=>e.id),'history event IDs');
    for(const event of record.events)if(event.requirementId!==id||event.before&&event.before.id!==id||event.after&&event.after.id!==id||record.complete&&(event.snapshotId&&!w.baselines.some(b=>b.id===event.snapshotId)||event.proposalId&&!(w.proposals??[]).some(p=>p.id===event.proposalId)))throw Error('Invalid historical reference.');
  }
  for(const [id,state] of Object.entries(w.snapshotImplementations??{}))if(!w.baselines.some(b=>b.id===id)||!Array.isArray(state.history))throw Error('Invalid snapshot implementation reference.');
}
function graphValue(archive:Pick<Archive,'records'>,root:string,limit=ARCHIVE_LIMITS.workspace){
  const nodes=new Map<string,Node>(),pending=[root];
  while(pending.length){const hash=pending.pop()!;if(nodes.has(hash))continue;const data=archive.records.get(hash);if(data===undefined)throw Error('Missing referenced archive record.');const node=parseNode(data);nodes.set(hash,node);pending.push(...references(node));}
  return materialize(root,nodes,limit);
}
export function payload(archive:Archive,project:ArchiveProject){return graphValue(archive,project.root) as ProjectPayload;}
export function archivedValue(archive:Archive,data:string):unknown{
  const value=JSON.parse(data);if(value?.storage_encoding===RECORD_ENCODING)return graphValue(archive,value.root);
  // Archive export normalizes legacy gzip into logical records before packing.
  if(value?.storage_encoding)throw Error('Unsupported legacy envelope in archive.');return value;
}
export function archiveWorkspace(archive:Archive,project:ArchiveProject){const p=payload(archive,project);return archivedValue(archive,p.workspace.data) as Workspace;}
function provenanceReceipts(value:unknown):ProjectPayload['receipts']{
  if(!value||typeof value!=='object')return [];const p=value as {inactive_source_receipts?:ProjectPayload['receipts'];prior?:unknown};
  return [...(Array.isArray(p.inactive_source_receipts)?p.inactive_source_receipts:[]),...provenanceReceipts(p.prior)];
}
export function projectRecords(archive:Archive,project:ArchiveProject){
  const data=payload(archive,project),roots=[project.root];
  for(const text of [data.workspace.data,...data.versions.flatMap(v=>[v.data,...(v.legacy_data?[v.legacy_data]:[])]),...[...data.receipts,...provenanceReceipts(data.provenance)].map(r=>r.result)]){const p=JSON.parse(text);if(p?.storage_encoding===RECORD_ENCODING)roots.push(p.root);}
  const records=new Map<string,string>(),pending=roots;
  while(pending.length){const hash=pending.pop()!;if(records.has(hash))continue;const value=archive.records.get(hash);if(value===undefined)throw Error('Missing referenced archive record.');records.set(hash,value);pending.push(...references(parseNode(value)));}
  return records;
}

export async function captureArchive(db:D1Database,scope:string|'all',signal?:AbortSignal):Promise<Archive>{
  // One transactional batch captures every mutable root. Content-addressed
  // payloads are immutable and may then be fetched in bounded chunks.
  const filter=scope==='all'?'':' WHERE id=?',args=scope==='all'?[]:[scope];
  const rows=await db.batch([
    db.prepare('SELECT id,data,version FROM workspaces'+filter+' ORDER BY id').bind(...args),
    db.prepare('SELECT project,version,data,sha256,legacy_data,created_at FROM workspace_storage_versions'+(scope==='all'?'':' WHERE project=?')+' ORDER BY project,version').bind(...args),
    db.prepare('SELECT key,project,fingerprint,result,expires_at FROM mcp_receipts WHERE expires_at>?'+(scope==='all'?'':' AND project=?')+' ORDER BY key').bind(Date.now(),...args),
    db.prepare('SELECT project,data FROM workspace_provenance'+(scope==='all'?'':' WHERE project=?')).bind(...args),
    db.prepare('SELECT key,actor,fingerprint,result,created_at FROM workspace_imports ORDER BY key'),
    db.prepare('SELECT project,actor,key,fingerprint,version,deleted_at,expires_at FROM workspace_deletions'+(scope==='all'?'':' WHERE project=?')+' ORDER BY project').bind(...args)
  ]);
  if((!rows[0].results.length&&!(scope==='all'&&rows[5].results.length))||rows[0].results.length>ARCHIVE_LIMITS.projects)throw Error('Export requires 1–50 saved workspaces.');
  const records=new Map<string,string>(),collected=new Map<string,Set<string>>();let expanded=0;
  function add(hash:string,data:string){if(records.has(hash))return;expanded+=bytes(data).length;if(expanded>ARCHIVE_LIMITS.expanded||records.size>=ARCHIVE_LIMITS.records)throw Error('Workspace archive exceeds the supported expanded size or record count. Export fewer projects.');records.set(hash,data);}
  async function graph(value:unknown){const result=await buildGraph(value);for(const [h,s] of result.records)add(h,s);return result.root;}
  async function collect(project:string,data:string):Promise<string>{
    checkAbort(signal);const value=JSON.parse(data);
    if(value?.storage_encoding===RECORD_ENCODING){
      // Historical roots share most records. Verify each row once per project
      // and capture, without letting another project's identical hash satisfy it.
      let pending=[value.root];const seen=collected.get(project)??new Set<string>();collected.set(project,seen);
      while(pending.length){checkAbort(signal);const hashes=[...new Set(pending)].filter(h=>!seen.has(h)).slice(0,192);if(!hashes.length)break;const selected=new Set(hashes);pending=pending.filter(h=>!selected.has(h));
        const groups=[];for(let i=0;i<hashes.length;i+=24)groups.push(hashes.slice(i,i+24));
        const results=await db.batch<{hash:string;data:string}>(groups.map(group=>db.prepare(`SELECT hash,data FROM workspace_records WHERE project=? AND hash IN (${group.map(()=>'?').join(',')})`).bind(project,...group)));
        for(const [index,result] of results.entries()){
          if(result.results.length!==groups[index].length)throw Error('Missing durable archive record.');
          for(const r of result.results){if(await sha256(r.data)!==r.hash)throw Error('Storage checksum failed.');add(r.hash,r.data);seen.add(r.hash);pending.push(...references(parseNode(r.data)));}
        }
      }return data;
    }
    if(value?.storage_encoding==='wonderworks.workspace.gzip.v1'){
      const packed=Uint8Array.from(atob(value.payload),c=>c.charCodeAt(0));const reader=new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();let text='';const decoder=new TextDecoder();while(true){const {done,value}=await reader.read();if(done)break;text+=decoder.decode(value,{stream:true});if(text.length>ARCHIVE_LIMITS.workspace){await reader.cancel();throw Error('Legacy expansion limit exceeded.');}}text+=decoder.decode();
      const decoded=JSON.parse(text);return JSON.stringify({storage_encoding:RECORD_ENCODING,root:await graph(decoded),...(decoded?.name?{name:decoded.name}:{})});
    }
    return JSON.stringify({storage_encoding:RECORD_ENCODING,root:await graph(value),...(value?.name?{name:value.name}:{})});
  }
  const projects:ArchiveProject[]=[];
  for(const row of rows[0].results as StoredRow[]){
    const workspace={...row,data:await collect(row.id,row.data)},versions=[];
    for(const v of rows[1].results as ProjectPayload['versions'])if(v.project===row.id)versions.push({...v,data:await collect(row.id,v.data),legacy_data:v.legacy_data?await collect(row.id,v.legacy_data):null});
    const receipts=[];for(const r of rows[2].results as ProjectPayload['receipts'])if(r.project===row.id)receipts.push({...r,expires_at:Number(r.expires_at),result:await collect(row.id,r.result)});
    const provenanceRow=(rows[3].results as {project:string;data:string}[]).find(p=>p.project===row.id)?.data;
    const provenance=provenanceRow?archivedValue({records} as Archive,await collect(row.id,provenanceRow)):undefined;
    if(provenance){for(const r of provenanceReceipts(provenance))await collect(row.id,r.result);}
    const root=await graph({workspace,versions,receipts,...(provenance?{provenance}:{})});
    const w=archivedValue({records} as Archive,workspace.data) as Workspace;validateWorkspace(w);
    projects.push({id:row.id,name:w.name,version:row.version,...(w.requirementsVersion===undefined?{}:{requirementsVersion:w.requirementsVersion}),root});
  }
  const ids=new Set(projects.map(p=>p.id));
  const operations=(rows[4].results as {key:string;actor:string;fingerprint:string;result:string;created_at:string}[]).filter(op=>{const result=JSON.parse(op.result) as {projects:{id:string}[]};return Array.isArray(result.projects)&&result.projects.length&&result.projects.every(p=>ids.has(p.id));});
  const operationsRoot=operations.length?await graph(operations):undefined;
  const deletions=scope==='all'&&rows[5].results.length?await graph((rows[5].results as DeletionRecord[]).map(row=>({...row,expires_at:Number(row.expires_at)}))):undefined;
  const manifest:ArchiveManifest={format:'wonderworks.workspace',version:deletions?2:1,storage:RECORD_ENCODING,producer:'wonderworks/0.2.0',id:crypto.randomUUID(),createdAt:new Date().toISOString(),projects,records:[...records].map(([hash,data])=>({hash,bytes:bytes(data).length})),expandedBytes:expanded,...(operationsRoot?{operations:operationsRoot}:{}),...(deletions?{deletions}:{})};
  return {manifest,records,fingerprint:await sha256(JSON.stringify(manifest))};
}

// Zip retains each added file until its directory is written. ZipDeflate keeps
// a streaming compressor (including a 96 KiB input buffer) on every file, so
// thousands of entries retain hundreds of MiB. Each bounded record is already
// supplied in one chunk; synchronous per-entry deflation releases that state.
class RecordZipDeflate extends ZipPassThrough {
  compression=8;
  protected process(chunk:Uint8Array,final:boolean){
    if(!final)throw Error('Archive records must be encoded in one bounded chunk.');
    this.ondata(null,deflateSync(chunk,{level:6}),true);
  }
}
export function encodeArchive(archive:Archive,signal?:AbortSignal):ReadableStream<Uint8Array>{
  let zip:Zip,ended=false,compressed=0;
  const entries=[['manifest.json',JSON.stringify(archive.manifest)],...[...archive.records].map(([hash,data])=>['records/'+hash+'.json',data])];let index=0;
  return new ReadableStream({
    start(controller){zip=new Zip((error,data,final)=>{if(ended)return;if(error){ended=true;controller.error(error);return;}compressed+=data.length;if(compressed>ARCHIVE_LIMITS.compressed){ended=true;zip.terminate();controller.error(Error('Compressed archive exceeds 32 MiB. Export fewer projects.'));return;}controller.enqueue(data);if(final){ended=true;controller.close();}});},
    pull(controller){try{checkAbort(signal);if(index<entries.length){const [name,data]=entries[index++],file=new RecordZipDeflate(name);zip.add(file);file.push(bytes(data),true);}else zip.end();}catch(error){ended=true;zip.terminate();controller.error(error);}},
    cancel(){ended=true;zip.terminate();}
  });
}
export async function completeArchive(archive:Archive,signal?:AbortSignal):Promise<Blob>{
  // Finish the bounded compressed file before committing HTTP success. A late
  // encoder failure must become an export error, not a downloadable ZIP prefix.
  const blob=await new Response(encodeArchive(archive,signal)).blob();
  await validateArchiveDownload(blob,signal);
  return blob;
}
export async function decodeArchive(stream:ReadableStream<Uint8Array>,signal?:AbortSignal):Promise<Archive>{
  let compressed=0,expanded=0,manifestText='',failure:Error|undefined,tail=new Uint8Array(0);const files=new Map<string,string>(),completed=new Set<string>();
  const unzip=new Unzip(file=>{
    if(files.has(file.name)||file.name!=='manifest.json'&&!/^records\/[a-f0-9]{64}\.json$/.test(file.name)||files.size>ARCHIVE_LIMITS.records){failure=Error('Duplicate, unsafe or unsupported archive path.');return;}
    files.set(file.name,'');const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
    file.ondata=(error,chunk,final)=>{if(failure)return;if(error){failure=error;return;}size+=chunk.length;expanded+=chunk.length;
      if(size>(file.name==='manifest.json'?ARCHIVE_LIMITS.manifest:65536)||expanded>ARCHIVE_LIMITS.expanded+ARCHIVE_LIMITS.manifest){failure=Error('Archive expansion limit exceeded.');file.terminate();return;}
      try{text+=decoder.decode(chunk,{stream:!final});if(final){files.set(file.name,text);completed.add(file.name);}}catch{failure=Error('Archive must contain UTF-8 JSON.');}
    };if(file.compression!==0&&file.compression!==8){failure=Error('Unsupported ZIP compression.');return;}file.start();
  });unzip.register(UnzipInflate);
  const reader=stream.getReader();
  try{while(true){checkAbort(signal);const {done,value}=await reader.read();if(done)break;compressed+=value.length;if(compressed>ARCHIVE_LIMITS.compressed)throw Error('Archive exceeds 32 MiB.');const keep=Math.min(tail.length,Math.max(0,2*1024*1024-value.length)),next=new Uint8Array(keep+Math.min(value.length,2*1024*1024));next.set(tail.subarray(tail.length-keep));next.set(value.subarray(Math.max(0,value.length-2*1024*1024)),keep);tail=next;for(let i=0;i<value.length;i+=16384){unzip.push(value.subarray(i,i+16384),false);if(failure)throw failure;}}unzip.push(new Uint8Array(),true);if(failure)throw failure;}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  if(completed.size!==files.size)throw Error('Incomplete archive.');validateArchiveDirectory(tail,compressed,files);manifestText=files.get('manifest.json')??'';
  const m=JSON.parse(manifestText) as ArchiveManifest;jsonDepth(m);
  if(m.format!=='wonderworks.workspace'||![ARCHIVE_VERSION,2].includes(m.version)||m.storage!==RECORD_ENCODING||!Array.isArray(m.projects)||(!m.projects.length&&!m.deletions)||m.projects.length>ARCHIVE_LIMITS.projects||!Array.isArray(m.records)||m.records.length>ARCHIVE_LIMITS.records||typeof m.id!=='string'||!m.id||files.size!==m.records.length+1)throw Error('Unsupported or malformed workspace archive.');
  unique(m.projects.map(p=>p.id),'workspace IDs');unique(m.records.map(r=>r.hash),'record hashes');
  const records=new Map<string,string>();let count=0;
  for(const r of m.records){const data=files.get('records/'+r.hash+'.json');if(!hashPattern.test(r.hash)||data===undefined||bytes(data).length!==r.bytes||await sha256(data)!==r.hash)throw Error('Missing or corrupt archive record.');count+=r.bytes;const node=parseNode(data);jsonDepth(node);records.set(r.hash,data);}
  if(count!==m.expandedBytes||count>ARCHIVE_LIMITS.expanded)throw Error('Archive size manifest does not match.');
  for(const data of records.values())for(const hash of references(parseNode(data)))if(!records.has(hash))throw Error('Missing referenced archive record.');
  const archive={manifest:m,records,fingerprint:await sha256(manifestText)};
  for(const p of m.projects){if(!projectPattern.test(p.id)||!hashPattern.test(p.root))throw Error('Invalid archive project identity.');const data=payload(archive,p),w=archiveWorkspace(archive,p);validateWorkspace(w);if(w.id!==p.id||data.workspace.id!==p.id||w.version!==p.version||data.workspace.version!==p.version)throw Error('Archive workspace identity/version mismatch.');
    if(!Array.isArray(data.versions)||!Array.isArray(data.receipts))throw Error('Missing durable workspace records.');unique(data.versions.map(v=>String(v.version)),'storage versions');unique(data.receipts.map(r=>r.key),'retry keys');
    for(const v of data.versions){if(v.project!==p.id||!Number.isSafeInteger(v.version)||v.version>p.version||v.version<0)throw Error('Invalid storage version.');const value=archivedValue(archive,v.data);if(await sha256(JSON.stringify(value))!==v.sha256)throw Error('Storage version checksum failed.');if(v.legacy_data)archivedValue(archive,v.legacy_data);}
    for(const r of data.receipts){if(r.project!==p.id||!hashPattern.test(r.key)||!hashPattern.test(r.fingerprint)||!Number.isSafeInteger(r.expires_at))throw Error('Invalid retry receipt scope.');archivedValue(archive,r.result);}
    for(const r of provenanceReceipts(data.provenance))archivedValue(archive,r.result);
  }
  if(m.operations)graphValue(archive,m.operations);
  const deletions=archiveDeletions(archive);
  if(m.deletions&&m.version!==2)throw Error('Invalid deletion archive version.');
  unique(deletions.map(d=>d.project),'deleted project IDs');
  for(const d of deletions)if(!projectPattern.test(d.project)||m.projects.some(p=>p.id===d.project)||typeof d.actor!=='string'||!d.actor||!hashPattern.test(d.key)||!hashPattern.test(d.fingerprint)||!Number.isSafeInteger(d.version)||d.version<1||!Number.isSafeInteger(d.expires_at)||!Number.isFinite(Date.parse(d.deleted_at))||Object.keys(d).sort().join(',')!=='actor,deleted_at,expires_at,fingerprint,key,project,version')throw Error('Invalid workspace deletion record.');
  return archive;
}

export function archiveOperations(archive:Archive){return archive.manifest.operations?graphValue(archive,archive.manifest.operations) as {key:string;actor:string;fingerprint:string;result:string;created_at:string}[]:[];}

export function archiveDeletions(archive:Archive):DeletionRecord[]{const rows=archive.manifest.deletions?graphValue(archive,archive.manifest.deletions):[];if(!Array.isArray(rows))throw Error('Invalid workspace deletion records.');return rows;}
