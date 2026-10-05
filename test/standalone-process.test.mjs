import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase,migrate} from '../server/database.mjs';
import {passwordHash,tokenHash} from '../server/auth.mjs';
const standaloneBuilt=await readFile('dist/wonderworks-profile.json','utf8').then(s=>JSON.parse(s).profile==='standalone').catch(()=>false);
const root=process.cwd(),dir=await mkdtemp(join(tmpdir(),'ww-process-')),children=[];
test.after(async()=>{for(const c of children)if(c.exitCode===null){c.kill('SIGTERM');await new Promise(r=>c.once('exit',r));}await rm(dir,{recursive:true,force:true});});
async function start(env){const child=spawn(process.execPath,['server/start.mjs'],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(child);let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const origin=env.WW_PUBLIC_URL??'http://127.0.0.1:'+env.WW_PORT;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{const r=await fetch(origin+'/health/ready');if(r.ok)return {child,origin,logs:()=>logs};}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Readiness timeout: '+logs);}
async function stop(child){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
async function json(origin,path,body,headers={},status=200){const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();assert.equal(r.status,status,text);return text?JSON.parse(text):null;}
async function rpc(origin,name,args={},headers={}){const response=await json(origin,'/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}, {Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...headers});assert.equal(response.result.isError,false,JSON.stringify(response));return response.result.structuredContent;}

test('production SQLite restart, MCP discovery/Draft, host/Origin trust, UI and archive HTTP paths',{skip:!standaloneBuilt},async()=>{
  const path=join(dir,'process.sqlite'),db=await openDatabase({profile:'local',sqlitePath:path},{create:true});await migrate(db);await db.close();
  const env={WW_PROFILE:'local',WW_SQLITE_PATH:path,WW_PORT:'5182'},first=await start(env),origin=first.origin;
  assert.equal((await fetch(origin)).status,200);
  assert.equal(await new Promise((resolve,reject)=>{httpRequest(origin+'/health/ready',{headers:{Host:'evil.example','X-Forwarded-Host':new URL(origin).host}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject).end();}),403);
  const doc=await json(origin,'/api/workspace',{action:'project',name:'Process persistence QA',prefix:'PQ'});
  await json(origin,'/api/workspace',{action:'section',project:doc.id,version:0,section:{title:'Rejected origin',description:''}},{Origin:'https://evil.example'},403);
  const args={project_id:doc.id,expected_workspace_version:0,idempotency_key:'sqlite-process-retry',title:'Survive process restart',description:''};
  const result=await rpc(origin,'create_proposal',args,{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'forged@example.test'});
  let saved=await json(origin,'/api/workspace?project='+doc.id);assert.equal(saved.history[0].mcp.actorId,'local-user');
  await stop(first.child);const second=await start(env);assert.deepEqual(await rpc(second.origin,'create_proposal',args),result);saved=await json(origin,'/api/workspace?project='+doc.id);assert.equal(saved.proposals.length,1);
  const exported=await fetch(origin+'/api/workspace-archive?scope='+doc.id);assert.equal(exported.status,200);assert.match(exported.headers.get('cache-control'),/no-store/);const zip=await exported.arrayBuffer();
  const preview=await fetch(origin+'/api/workspace-archive?action=preview',{method:'POST',body:zip});assert.equal(preview.status,200);assert.equal((await preview.json()).projects[0].conflict,true);
  const operation='process-import-'+crypto.randomUUID(),headers={'X-Workspace-Operation':operation,'X-Workspace-Selection':JSON.stringify([{id:doc.id,mode:'copy'}])};
  const imported=await (await fetch(origin+'/api/workspace-archive?action=import',{method:'POST',headers,body:zip})).json();assert.ok(imported.projects?.[0].id,JSON.stringify(imported));
  await stop(second.child);await start(env);
  assert.deepEqual(await (await fetch(origin+'/api/workspace-archive?action=import',{method:'POST',headers,body:zip})).json(),imported);
  const provenance=await json(origin,'/api/workspace-archive?provenance='+imported.projects[0].id);assert.equal(provenance.source_project,doc.id);
  const deployment=await json(origin,'/api/deployment');assert.equal(deployment.profile,'local');assert.equal(deployment.toolCount,18);
});

test('two PostgreSQL production processes share authentication, CAS/retry state and revoked access',{skip:!standaloneBuilt||!process.env.WW_TEST_POSTGRES_URL},async()=>{
  const accountPath=join(dir,'accounts.json'),token='process-test-token-'.repeat(3),user={id:'process-actor',email:'process@example.test',allowed:true,password:passwordHash('process-test-password'),tokens:[tokenHash(token)]};
  await writeFile(accountPath,JSON.stringify({users:[user]}),{mode:0o600});
  const cfg={profile:'self-hosted',databaseUrl:process.env.WW_TEST_POSTGRES_URL,tls:'disable'},db=await openDatabase(cfg);await migrate(db);await db.close();
  const base={WW_PROFILE:'self-hosted',WW_AUTH:'accounts',WW_HOST:'127.0.0.1',WW_DATABASE_URL:process.env.WW_TEST_POSTGRES_URL,WW_PG_TLS:'disable',WW_ACCOUNTS_FILE:accountPath,WW_SESSION_SECRET:'synthetic-process-session-secret-'.repeat(2)};
  const a=await start({...base,WW_PORT:'5183',WW_PUBLIC_URL:'http://127.0.0.1:5183'}),b=await start({...base,WW_PORT:'5184',WW_PUBLIC_URL:'http://127.0.0.1:5184'}),headers={Authorization:'Bearer '+token};
  for(const forged of [{},{'oai-authenticated-user-id':user.id,'oai-authenticated-user-email':user.email},{'oai-sites-authorization':'forged-bypass','X-Forwarded-For':'127.0.0.1'}])await json(a.origin,'/api/workspace?index=1',null,forged,401);
  const login=await fetch(a.origin+'/login',{method:'POST',redirect:'manual',headers:{Origin:a.origin},body:new URLSearchParams({id:user.id,password:'process-test-password'})});assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(a.origin,{headers:{Cookie:cookie}})).status,200);
  const doc=await json(a.origin,'/api/workspace',{action:'project',name:'PostgreSQL process QA',prefix:'PG'},headers),args={project_id:doc.id,expected_workspace_version:0,idempotency_key:'two-process-key',title:'Concurrent independent servers',description:''};
  const results=await Promise.all([rpc(a.origin,'create_proposal',args,headers),rpc(b.origin,'create_proposal',args,headers)]);assert.deepEqual(results[0],results[1]);
  const saved=await json(b.origin,'/api/workspace?project='+doc.id,null,headers);assert.equal(saved.proposals.length,1);assert.equal(saved.history[0].mcp.actorId,user.id);
  await stop(a.child);const restarted=await start({...base,WW_PORT:'5183',WW_PUBLIC_URL:a.origin});assert.deepEqual(await rpc(restarted.origin,'create_proposal',args,headers),results[0]);
  const deletion={project_id:doc.id,expected_workspace_version:saved.version,idempotency_key:'process-deletion-retry-key'};
  const deleted=await json(a.origin,'/api/workspace-deletion',deletion,headers);assert.equal(deleted.deleted,true);
  assert.deepEqual(await json(b.origin,'/api/workspace-deletion',deletion,headers),deleted);
  await json(b.origin,'/api/workspace?project='+doc.id,null,headers,404);
  await json(a.origin,'/api/workspace',{action:'section',project:doc.id,version:saved.version,section:{title:'Stale process',description:''}},headers,404);
  const racing=await json(a.origin,'/api/workspace',{action:'project',name:'Delete versus independent save',prefix:'RC'},headers);
  const raced=await Promise.all([fetch(a.origin+'/api/workspace-deletion',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({project_id:racing.id,expected_workspace_version:0,idempotency_key:'cross-process-deletion-race'})}),fetch(b.origin+'/api/workspace',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action:'section',project:racing.id,version:0,section:{title:'Concurrent saved change',description:''}})})]);
  const raceResults=await Promise.all(raced.map(async response=>({status:response.status,body:await response.json()})));
  assert.equal(raced.filter(r=>r.status===200).length,1,JSON.stringify(raceResults));assert.ok(raced.some(r=>[404,409].includes(r.status)),JSON.stringify(raceResults));
  const outcome=await fetch(a.origin+'/api/workspace?project='+racing.id,{headers});if(raced[0].status===200)assert.equal(outcome.status,404);else{const retained=await outcome.json();assert.equal(retained.version,1);assert.equal(retained.sections[0].title,'Concurrent saved change');}
  const mcpRace=await json(a.origin,'/api/workspace',{action:'project',name:'Delete versus independent MCP',prefix:'MC'},headers);
  const [mcpDelete,mcpWrite]=await Promise.all([
    fetch(a.origin+'/api/workspace-deletion',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({project_id:mcpRace.id,expected_workspace_version:0,idempotency_key:'cross-process-mcp-deletion'})}),
    json(b.origin,'/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'create_proposal',arguments:{project_id:mcpRace.id,expected_workspace_version:0,idempotency_key:'cross-process-mcp-save',title:'Concurrent proposal',description:''}}},{...headers,Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'})
  ]);
  if(mcpDelete.status===200){assert.equal(mcpWrite.result.isError,true);assert.equal(mcpWrite.result.structuredContent.error.code,'NOT_FOUND',JSON.stringify(mcpWrite));}
  else{assert.equal(mcpDelete.status,409);assert.equal(mcpWrite.result.isError,false,JSON.stringify(mcpWrite));}
  user.allowed=false;await writeFile(accountPath,JSON.stringify({users:[user]}));await json(b.origin,'/api/workspace?index=1',null,headers,403);await json(a.origin,'/api/workspace?index=1',null,{Cookie:cookie},403);
  assert.ok(!a.logs().includes('synthetic-local-testing-only'));assert.ok(!b.logs().includes(token));
});
