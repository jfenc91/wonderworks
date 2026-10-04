// Read a single JSON line from hidden stdin: {url,token,backupDirectory}.
// The token is never written to a file, command argument, or output.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
console.log('Ready for migration configuration on stdin (input is hidden).');
let buffer='';const input=await new Promise(resolveLine=>process.stdin.on('data',chunk=>{buffer+=chunk;const i=buffer.indexOf('\n');if(i>=0){process.stdin.pause();resolveLine(buffer.slice(0,i));}}));
const {url,token,backupDirectory}=JSON.parse(input),origin=new URL(url).origin;
if(!backupDirectory||!token)throw Error('A backup directory and existing Site access token are required.');
const directory=resolve(backupDirectory);await mkdir(directory,{recursive:true,mode:0o700});
const headers={'OAI-Sites-Authorization':'Bearer '+token,'Content-Type':'application/json','Cache-Control':'no-cache'};
const request=async(path,body)=>{const r=await fetch(origin+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('Storage maintenance request failed: '+r.status+' '+await r.text());return r.json();};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const projects=await request('/api/workspace?index=1'),report=[];
// Back up every project before migrating any project.
const captured=[];
for(const p of projects){const doc=await request('/api/workspace?project='+encodeURIComponent(p.id));const hash=digest(doc);const path=resolve(directory,encodeURIComponent(p.id)+'-v'+doc.version+'-'+hash.slice(0,12)+'.json');await writeFile(path,JSON.stringify(doc),{mode:0o600,flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});if(digest(JSON.parse(await readFile(path,'utf8')))!==hash)throw Error('Backup verification failed: '+p.id);captured.push({project:p,doc,hash,path});}
await writeFile(resolve(directory,'backup-manifest.json'),JSON.stringify(captured.map(({project,doc,hash,path})=>({project_id:project.id,version:doc.version,sha256:hash,path})),null,2),{mode:0o600});
for(const {project,doc,hash,path} of captured){
 const migration=await request('/api/storage-migration',{project_id:project.id,expected_workspace_version:doc.version});
 const after=await request('/api/workspace?project='+encodeURIComponent(project.id));
 if(after.version!==doc.version)throw Error('Workspace changed during verification; backup retained. Re-run with a fresh read: '+project.id);
 if(digest(after)!==hash)throw Error('STOP: post-migration content differs from the backup: '+project.id);
 report.push({project_id:project.id,name:project.name,workspace_version:doc.version,status:migration.status,sha256:hash,backup:path,requirements:doc.requirements.length,proposals:doc.proposals.length,snapshots:doc.baselines.length,history_events:Object.values(doc.requirementHistory??{}).reduce((n,r)=>n+r.events.length,0),verified:true});
 console.log(JSON.stringify(report.at(-1)));
 await writeFile(resolve(directory,'migration-verification.json'),JSON.stringify(report,null,2),{mode:0o600});
}
await writeFile(resolve(directory,'migration-verification.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({complete:true,projects:report.length,report:resolve(directory,'migration-verification.json')}));
