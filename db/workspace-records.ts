import {decodeStoredRecord} from './workspace-codec';

// Immutable record trees keep every D1 row bounded independently of total
// project size or compressibility. Arrays preserve order; objects preserve
// property order and unknown/legacy fields. Identical content is shared on disk.
export const RECORD_ENCODING='wonderworks.workspace.records.v2';
const LEAF_BYTES=32_000,MAX_ROW_BYTES=65_536,FANOUT=128;
type Node={type:'value';value:unknown}|{type:'object';entries:[string,string][]}|
  {type:'array'|'arrays'|'objects'|'text';items:string[]};
type Pointer={storage_encoding:typeof RECORD_ENCODING;name?:string;root:string};
type Graph={root:string;records:Map<string,string>;sha256:string};
const bytes=(s:string)=>new TextEncoder().encode(s);
export async function sha256(s:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function isRecordPointer(data:string){return JSON.parse(data)?.storage_encoding===RECORD_ENCODING;}
function pointer(graph:Graph,value:unknown){return JSON.stringify({storage_encoding:RECORD_ENCODING,...(value&&typeof value==='object'&&'name' in value?{name:(value as {name?:string}).name}:{}),root:graph.root});}
function references(node:Node){return node.type==='value'?[]:node.type==='object'?node.entries.flat():node.items;}
function validHash(value:unknown):value is string{return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
function parseNode(data:string):Node{
  if(bytes(data).length>MAX_ROW_BYTES)throw Error('Storage record exceeds its size limit');
  const n=JSON.parse(data);
  if(n?.type==='value'&&Object.hasOwn(n,'value'))return n;
  if(n?.type==='object'&&Array.isArray(n.entries)&&n.entries.every((e:unknown)=>Array.isArray(e)&&e.length===2&&e.every(validHash)))return n;
  if(['array','arrays','objects','text'].includes(n?.type)&&Array.isArray(n.items)&&n.items.every(validHash))return n;
  throw Error('Invalid storage record');
}
export async function buildGraph(value:unknown):Promise<Graph>{
  const json=JSON.stringify(value),records=new Map<string,string>();
  // Match the pre-existing JSON storage contract (including absent undefined
  // properties) before splitting. No authored field is selected or discarded.
  const normalized=JSON.parse(json);
  async function add(node:Node){const data=JSON.stringify(node);if(bytes(data).length>MAX_ROW_BYTES)throw Error('Storage record exceeds its size limit');const hash=await sha256(data);records.set(hash,data);return hash;}
  async function groups(type:'arrays'|'objects'|'text',items:string[]):Promise<string>{
    if(items.length<=FANOUT)return add({type,items});
    const parents=[];for(let i=0;i<items.length;i+=FANOUT)parents.push(await add({type,items:items.slice(i,i+FANOUT)}));
    return groups(type,parents);
  }
  async function visit(v:any,force=false):Promise<string>{
    if(!force&&bytes(JSON.stringify(v)).length<=LEAF_BYTES)return add({type:'value',value:v});
    if(typeof v==='string'){
      const items=[];for(let i=0;i<v.length;i+=4096)items.push(await add({type:'value',value:v.slice(i,i+4096)}));
      return groups('text',items);
    }
    if(Array.isArray(v)){
      const items=[];for(const item of v)items.push(await visit(item));
      if(items.length<=FANOUT)return add({type:'array',items});
      const parts=[];for(let i=0;i<items.length;i+=FANOUT)parts.push(await add({type:'array',items:items.slice(i,i+FANOUT)}));
      return groups('arrays',parts);
    }
    if(v&&typeof v==='object'){
      const entries:[string,string][]=[];
      for(const [key,item] of Object.entries(v))entries.push([await visit(key),await visit(item)]);
      if(entries.length<=FANOUT)return add({type:'object',entries});
      const parts=[];for(let i=0;i<entries.length;i+=FANOUT)parts.push(await add({type:'object',entries:entries.slice(i,i+FANOUT)}));
      return groups('objects',parts);
    }
    return add({type:'value',value:v});
  }
  return {root:await visit(normalized,true),records,sha256:await sha256(json)};
}

export async function readStoredRecord<T>(db:D1Database,project:string,data:string):Promise<T>{
  const envelope=JSON.parse(data);
  if(envelope?.storage_encoding!==RECORD_ENCODING)return decodeStoredRecord<T>(data);
  if(!validHash(envelope.root))throw Error('Invalid storage root');
  const nodes=new Map<string,Node>();let pending=[envelope.root];
  // Breadth-first, indexed reads. All records are immutable and the root was
  // captured with the workspace version, so concurrent commits cannot mix sets.
  while(pending.length){
    const hashes=[...new Set(pending)].filter(h=>!nodes.has(h));pending=[];
    for(let i=0;i<hashes.length;i+=24){
      const batch=hashes.slice(i,i+24),rows=await db.prepare(`SELECT hash,data FROM workspace_records WHERE project=? AND hash IN (${batch.map(()=>'?').join(',')})`).bind(project,...batch).all<{hash:string;data:string}>();
      if(rows.results.length!==batch.length)throw Error('Missing storage record; workspace was not loaded');
      for(const row of rows.results){
        if(await sha256(row.data)!==row.hash)throw Error('Storage integrity check failed');
        const node=parseNode(row.data);nodes.set(row.hash,node);pending.push(...references(node));
      }
    }
  }
  function materialize(hash:string,ancestors=new Set<string>()):any{
    if(ancestors.has(hash))throw Error('Cyclic storage records');
    const n=nodes.get(hash);if(!n)throw Error('Missing storage record');
    const path=new Set(ancestors);path.add(hash);
    const child=(h:string)=>materialize(h,path);
    // Never memoize returned objects: current, proposal, and frozen versions
    // must not alias each other even when their on-disk records are shared.
    if(n.type==='value')return structuredClone(n.value);
    if(n.type==='object')return Object.fromEntries(n.entries.map(([k,v])=>{const key=child(k);if(typeof key!=='string')throw Error('Invalid stored property name');return [key,child(v)];}));
    const parts=n.items.map(child);
    if(n.type==='array')return parts;
    if(n.type==='arrays'){if(parts.some(p=>!Array.isArray(p)))throw Error('Invalid stored array');return parts.flat();}
    if(n.type==='objects'){if(parts.some(p=>!p||typeof p!=='object'||Array.isArray(p)))throw Error('Invalid stored object');return Object.fromEntries(parts.flatMap(p=>Object.entries(p)));}
    if(parts.some(p=>typeof p!=='string'))throw Error('Invalid stored text');return parts.join('');
  }
  return materialize(envelope.root) as T;
}

export async function prepareStoredRecord(db:D1Database,project:string,value:unknown){
  const graph=await buildGraph(value),all=[...graph.records.keys()],existing=new Set<string>();
  for(let i=0;i<all.length;i+=80){const hashes=all.slice(i,i+80);const rows=await db.prepare(`SELECT hash FROM workspace_records WHERE project=? AND hash IN (${hashes.map(()=>'?').join(',')})`).bind(project,...hashes).all<{hash:string}>();for(const row of rows.results)existing.add(row.hash);}
  const missing=all.filter(hash=>!existing.has(hash));
  // Unpublished immutable records are safe to stage in bounded transactions.
  // Only the final CAS transaction can make them reachable. A failure or stale
  // write leaves the previous root, retry receipt, and history untouched.
  for(let i=0;i<missing.length;i+=200){
    const statements=[];
    for(let j=i;j<Math.min(i+200,missing.length);j+=20){const hashes=missing.slice(j,Math.min(j+20,i+200));statements.push(db.prepare(`INSERT OR IGNORE INTO workspace_records(project,hash,data) VALUES ${hashes.map(()=>'(?,?,?)').join(',')}`).bind(...hashes.flatMap(hash=>[project,hash,graph.records.get(hash)!])));}
    await db.batch(statements);
  }
  const data=pointer(graph,value),restored=await readStoredRecord(db,project,data);
  if(JSON.stringify(restored)!==JSON.stringify(value))throw Error('Storage round-trip verification failed');
  return {data,sha256:graph.sha256,recordCount:graph.records.size,newRecords:missing.length};
}

export async function prepareWorkspaceCommit(db:D1Database,project:string,expected:number,value:unknown){
  const before=await db.prepare('SELECT data,version FROM workspaces WHERE id=?').bind(project).first<{data:string;version:number}>();
  if(!before||before.version!==expected)throw Error('CONFLICT');
  const oldDoc=await readStoredRecord(db,project,before.data);
  const previous=await prepareStoredRecord(db,project,oldDoc);
  // Preserve the original legacy JSON/gzip envelope verbatim, in bounded
  // records, before replacing it. This is a recoverable pre-migration backup.
  const legacy=isRecordPointer(before.data)?null:(await prepareStoredRecord(db,project,before.data)).data;
  const next=await prepareStoredRecord(db,project,value);
  const backup=db.prepare('INSERT OR IGNORE INTO workspace_storage_versions(project,version,data,sha256,legacy_data,created_at) SELECT ?,?,?,?,?,? FROM workspaces WHERE id=? AND version=?')
    .bind(project,expected,previous.data,previous.sha256,legacy,new Date().toISOString(),project,expected);
  return {before,next,backup};
}

export async function migrateWorkspaceStorage(db:D1Database,project:string,expected:number){
  const row=await db.prepare('SELECT data,version FROM workspaces WHERE id=?').bind(project).first<{data:string;version:number}>();
  if(!row||row.version!==expected)throw Error('CONFLICT');
  const doc=await readStoredRecord(db,project,row.data),hash=await sha256(JSON.stringify(doc));
  if(isRecordPointer(row.data))return {project_id:project,workspace_version:expected,status:'already_migrated',sha256:hash};
  const prepared=await prepareWorkspaceCommit(db,project,expected,doc);
  const results=await db.batch([prepared.backup,db.prepare('UPDATE workspaces SET data=? WHERE id=? AND version=?').bind(prepared.next.data,project,expected)]);
  if(results[1].meta.changes!==1)throw Error('CONFLICT');
  return {project_id:project,workspace_version:expected,status:'migrated',sha256:hash,record_count:prepared.next.recordCount};
}
