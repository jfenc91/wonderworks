import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';

// Use an independently installed official v1 SDK, so this probe does not share
// transport or schema code with the server. It performs read-only calls.
const sdk=process.env.MCP_SDK_ROOT;
if(!sdk)throw Error('Set MCP_SDK_ROOT to an installed @modelcontextprotocol/sdk package directory.');
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('This cookie-based probe is for the local Sites sign-in emulator only.');
const {Client}=await import(pathToFileURL(resolve(sdk,'dist/esm/client/index.js')));
const {StreamableHTTPClientTransport}=await import(pathToFileURL(resolve(sdk,'dist/esm/client/streamableHttp.js')));
const login=await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'}),cookie=login.headers.get('set-cookie')?.split(';')[0];
const requestHeaders=process.env.WW_TEST_TOKEN?{Authorization:'Bearer '+process.env.WW_TEST_TOKEN}:cookie?{Cookie:cookie}:{};
const deployment=await (await fetch(origin+'/api/deployment',{headers:requestHeaders})).json();
assert.ok(cookie||deployment.profile==='local'||process.env.WW_TEST_TOKEN);
const client=new Client({name:'wonderworks-sdk-verification',version:'1.0.0'});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'),{requestInit:{headers:requestHeaders}}));
  assert.equal((await client.listTools()).tools.length,deployment.toolCount);
  const projects=await client.callTool({name:'list_projects',arguments:{limit:100}});assert.equal(projects.isError,false);assert.ok(projects.structuredContent.items.length);
  const project=await client.callTool({name:'get_project',arguments:{project_id:projects.structuredContent.items[0].id}});assert.equal(project.isError,false);
  console.log(JSON.stringify({client:'@modelcontextprotocol/sdk',version:JSON.parse(await readFile(resolve(sdk,'package.json'),'utf8')).version,transport:'Streamable HTTP',protocol:'2025-11-25',tools:deployment.toolCount,projectRead:true,browserRequired:false,profile:deployment.profile,authentication:deployment.auth}));
}finally{await client.close();}
