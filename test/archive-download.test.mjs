import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {workspace} from './fixtures/snapshot-workspace.mjs';
import {buildGraph,sha256,RECORD_ENCODING} from '../db/workspace-records.ts';
import {completeArchive,decodeArchive,archiveWorkspace} from '../lib/workspace-archive.ts';
import {validateArchiveDownload} from '../lib/archive-download.mjs';

const doc=workspace('complete-download');
const graph=await buildGraph(doc),pointer=JSON.stringify({storage_encoding:RECORD_ENCODING,root:graph.root});
const payload=await buildGraph({workspace:{id:doc.id,version:doc.version,data:pointer},versions:[],receipts:[]});
const records=new Map([...graph.records,...payload.records]);
// Match the reported record count with unique incompressible entries.
while(records.size<5123){const data=JSON.stringify({type:'value',value:randomBytes(768).toString('base64')});records.set(await sha256(data),data);}
const manifest={format:'wonderworks.workspace',version:1,storage:RECORD_ENCODING,producer:'test',id:'download-test',createdAt:new Date().toISOString(),projects:[{id:doc.id,name:doc.name,version:doc.version,root:payload.root}],records:[...records].map(([hash,data])=>({hash,bytes:Buffer.byteLength(data)})),expandedBytes:[...records.values()].reduce((n,s)=>n+Buffer.byteLength(s),0)};
const archive={manifest,records,fingerprint:await sha256(JSON.stringify(manifest))};
const blob=await completeArchive(archive),zip=new Uint8Array(await blob.arrayBuffer());
const directory=new DataView(zip.buffer).getUint32(zip.length-6,true);

test('a 5,123-record download completes and passes full import validation',async()=>{
  assert.ok(zip.length>4*1024*1024);
  await validateArchiveDownload(blob);
  const restored=await decodeArchive(blob.stream());
  assert.equal(restored.records.size,5123);assert.deepEqual(restored.records,records);
  assert.deepEqual(archiveWorkspace(restored,restored.manifest.projects[0]),doc);
});

test('normal EOF at an entry boundary, missing directory, and damaged counts are rejected',async()=>{
  let offset=directory;
  for(let i=0;i<2090;i++)offset+=46+new DataView(zip.buffer).getUint16(offset+28,true);
  const boundary=new DataView(zip.buffer).getUint32(offset+42,true);
  for(const length of [0,21,boundary,directory,zip.length-1]){
    const truncated=new Blob([zip.subarray(0,length)]);
    await assert.rejects(()=>validateArchiveDownload(truncated),/Incomplete workspace archive/);
    await assert.rejects(()=>decodeArchive(truncated.stream()));
  }
  const corrupt=zip.slice(),view=new DataView(corrupt.buffer);
  view.setUint16(corrupt.length-14,2,true);view.setUint16(corrupt.length-12,2,true);
  await assert.rejects(()=>validateArchiveDownload(new Blob([corrupt])),/Incomplete workspace archive/);
});

test('cancelled export and download checks do not produce a completed file',async()=>{
  const abort=new AbortController();abort.abort();
  await assert.rejects(()=>completeArchive(archive,abort.signal));
  await assert.rejects(()=>validateArchiveDownload(blob,abort.signal));
});

test('backup CLI rejects HTTP 200 truncation and preserves the previous backup',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ww-download-'));
  let body=zip.subarray(0,directory);
  const server=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/zip','X-Workspace-Count':'1'});res.end(body);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,file=join(dir,'backup.wwspace');
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/workspace-backup.mjs','backup',base,file],{cwd:new URL('..',import.meta.url),env:{...process.env,WW_COOKIE_FILE:'',WW_TOKEN_FILE:''}});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));
  });
  try{
    await writeFile(file,'previous complete backup');
    const failed=await run();assert.notEqual(failed.code,0);assert.match(failed.stderr,/Incomplete workspace archive/);assert.doesNotMatch(failed.stdout,/backup_complete/);
    assert.equal(await readFile(file,'utf8'),'previous complete backup');assert.deepEqual(await readFile(file+'.partial'),Buffer.from(body));
    await rm(file+'.partial');body=zip;
    const success=await run();assert.equal(success.code,0,success.stderr);assert.match(success.stdout,/backup_complete/);assert.deepEqual(await readFile(file),Buffer.from(zip));
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
