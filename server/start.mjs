import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {mkdtemp,rm,chmod,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {configuration} from './config.mjs';
import {openDatabase,readiness,SCHEMA_VERSION} from './database.mjs';
import {accounts,authenticate,authRoute,trustedRequest} from './auth.mjs';
const config=configuration();
try{if(config.auth==='accounts')await accounts(config);}catch{console.error('Authentication configuration is invalid. Check WW_ACCOUNTS_FILE schema and private file permissions.');process.exit(1);}
try{if(JSON.parse(await readFile('dist/wonderworks-profile.json','utf8')).profile!=='standalone')throw Error();}catch{console.error('Missing standalone build. Run npm run build:standalone before npm start.');process.exit(1);}
let db;try{db=await openDatabase(config);await readiness(db);}catch{console.error('Database is unavailable or requires setup. Check configuration/permissions and run npm run setup.');await db?.close();process.exit(1);}
globalThis.__wonderworksRuntime={db,config};
const root=process.cwd();
const vinextRoot=resolve(dirname(fileURLToPath(import.meta.resolve('vinext'))),'..');
const {startProdServer,sendWebResponse}=await import(pathToFileURL(resolve(vinextRoot,'dist/server/prod-server.js')));
// Initialize the pinned framework server on a private Unix socket, never an
// unauthenticated TCP listener. Reuse its full production request handler behind
// our boundary (including asset manifests, SSR context and streaming).
const bootstrap=await mkdtemp(resolve(tmpdir(),'wonderworks-'));
await chmod(bootstrap,0o700);
const internal=await startProdServer({port:resolve(bootstrap,'http.sock'),host:undefined,outDir:resolve(root,'dist'),silent:true});
const handlers=internal.server.listeners('request');
await new Promise(done=>internal.server.close(done));await rm(bootstrap,{recursive:true,force:true});
const server=createServer(async(req,res)=>{
  const correlationId=crypto.randomUUID();
  try{
    if(req.headers.host!==new URL(config.baseUrl).host){res.writeHead(403);res.end('Host rejected.');return;}
    const url=new URL(req.url,config.baseUrl);
    if(url.origin!==config.baseUrl){res.writeHead(403);res.end('Origin rejected.');return;}
    if(url.pathname==='/health/live'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"status":"live"}');return;}
    if(url.pathname==='/health/ready'){
      let ok=true;try{if(config.auth==='accounts')await accounts(config);await readiness(db);}catch{ok=false;}
      res.writeHead(ok?200:503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({status:ok?'ready':'unavailable',profile:config.profile,schema:SCHEMA_VERSION}));return;
    }
    const abort=new AbortController();req.on('aborted',()=>abort.abort());res.on('close',()=>{if(!res.writableFinished)abort.abort();});
    const isLogin=['/login','/signin-with-chatgpt','/signout-with-chatgpt'].includes(url.pathname);
    const request=new Request(url,{method:req.method,headers:req.headers,signal:abort.signal,...(isLogin&&!['GET','HEAD'].includes(req.method)?{body:Readable.toWeb(req),duplex:'half'}:{})});
    const login=await authRoute(config,request,req.socket.remoteAddress,db);
    if(login){await sendWebResponse(login,req,res,false);return;}
    const auth=await authenticate(config,request,req.socket.remoteAddress,db);
    if(auth.status&&(url.pathname!=='/mcp'||auth.status===403)){
      const isPage=req.method==='GET'&&!url.pathname.startsWith('/api/');
      await sendWebResponse(isPage&&auth.status===401?new Response(null,{status:303,headers:{Location:'/login','Cache-Control':'no-store'}}):Response.json({error:auth.status===403?'Access denied.':'Authentication required.'},{status:auth.status,headers:{'Cache-Control':'no-store'}}),req,res,false);return;
    }
    const trusted=trustedRequest(request,auth.user);
    req.headers=Object.fromEntries(trusted.headers);req.rawHeaders=[...trusted.headers].flat();
    // Scheme comes only from validated configuration, never Forwarded headers.
    if(config.baseUrl.startsWith('https:'))req.socket.encrypted=true;
    for(const handler of handlers)handler.call(internal.server,req,res);
  }catch{
    console.error(JSON.stringify({event:'request_failure',correlationId}));
    if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({error:'Service unavailable. Retry after recovery.',correlation_id:correlationId}));
  }
});
server.requestTimeout=120000;server.headersTimeout=30000;
server.listen(config.port,config.host,()=>console.log(JSON.stringify({profile:config.profile,app:'0.2.0',schema:SCHEMA_VERSION,url:config.baseUrl,status:'listening'})));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(async()=>{await db.close();process.exit(0);});setTimeout(()=>process.exit(1),30000).unref();});
