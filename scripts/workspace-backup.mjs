import {createWriteStream} from 'node:fs';
import {readFile,rename,stat,writeFile} from 'node:fs/promises';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const [action,url,file]=process.argv.slice(2);
if(!['backup','restore-empty'].includes(action)||!url||!file)throw Error('Usage: npm run workspace -- backup|restore-empty BASE_URL PRIVATE_FILE.wwspace');
const base=new URL(url);if(base.username||base.password||!['https:','http:'].includes(base.protocol))throw Error('Use an HTTP(S) origin without credentials.');
const headers=process.env.WW_TOKEN_FILE?{Authorization:'Bearer '+(await readFile(process.env.WW_TOKEN_FILE,'utf8')).trim()}:{};
if(process.env.WW_COOKIE_FILE)headers.Cookie=(await readFile(process.env.WW_COOKIE_FILE,'utf8')).trim();
const endpoint=new URL('/api/workspace-archive',base);
async function checked(response){if(!response.ok)throw Error(`Transfer failed (HTTP ${response.status}); inspect authenticated application status. Retry uncertain restores with the same receipt file.`);return response;}
if(action==='backup'){
  endpoint.searchParams.set('scope','all');const response=await checked(await fetch(endpoint,{headers}));let size=0;
  await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_,next){size+=chunk.length;next(size>32*1024*1024?Error('Archive exceeds 32 MiB.'):null,chunk);}}),createWriteStream(file+'.partial',{flags:'wx',mode:0o600}));
  await rename(file+'.partial',file);console.log(JSON.stringify({status:'backup_complete',projects:Number(response.headers.get('x-workspace-count')),bytes:size}));
}else{
  if((await stat(file)).size>32*1024*1024)throw Error('Archive exceeds 32 MiB.');
  const body=await readFile(file);endpoint.searchParams.set('action','preview');const preview=await (await checked(await fetch(endpoint,{method:'POST',headers,body}))).json();
  let operation;try{operation=(await readFile(file+'.operation','utf8')).trim();}catch(e){if(e.code!=='ENOENT')throw e;operation=crypto.randomUUID();await writeFile(file+'.operation',operation,{mode:0o600,flag:'wx'});}
  endpoint.searchParams.set('action','restore-empty');
  const result=await (await checked(await fetch(endpoint,{method:'POST',body,headers:{...headers,'Content-Type':'application/zip','X-Workspace-Operation':operation,'X-Workspace-Selection':JSON.stringify(preview.projects.map(p=>({id:p.id,mode:'restore'})))}}))).json();
  console.log(JSON.stringify({status:'restore_complete',project_count:result.projects.length}));
}
