import {tools,toolMap} from './contracts';
import {callTool,type Store} from './service';
import {ToolError,ProtocolError} from './errors';

export const PROTOCOL_VERSIONS=['2025-11-25','2025-06-18','2025-03-26'] as const;
export const MAX_REQUEST_BYTES=250000;
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const response=(body:unknown,status=200,headers:Record<string,string>={})=>Response.json(body,{status,headers:{'Cache-Control':'no-store',...headers}});
const rpcError=(id:unknown,error:ProtocolError)=>response({jsonrpc:'2.0',id:id??null,error:{code:error.code,message:error.message,...(error.data?{data:error.data}:{})}},error.status);

export function originAllowed(request:Request){
  const origin=request.headers.get('origin');
  if(!origin)return true;
  try{return new URL(origin).origin===origin&&origin===new URL(request.url).origin;}catch{return false;}
}
export async function readBody(request:Request){
  if(Number(request.headers.get('content-length'))>MAX_REQUEST_BYTES)throw new ProtocolError(-32600,'Request exceeds 250000 bytes.',413);
  const reader=request.body?.getReader();if(!reader)throw new ProtocolError(-32700,'A JSON request body is required.');
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_REQUEST_BYTES){await reader.cancel();throw new ProtocolError(-32600,'Request exceeds 250000 bytes.',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ProtocolError(-32700,'Invalid JSON.');}
}

export async function handleMcp(request:Request,store:Store){
  let id:unknown=null;const correlationId=crypto.randomUUID();
  try{
    if(!originAllowed(request))return response({error:'Origin rejected.'},403);
    if(request.method!=='POST')return response({error:'Use POST for stateless MCP requests.'},405,{Allow:'POST'});
    if(!request.headers.get('content-type')?.split(';')[0].trim().match(/^application\/json$/i))return response({error:'Content-Type must be application/json.'},415);
    const accept=request.headers.get('accept')??'';
    if(!accept.includes('application/json')||!accept.includes('text/event-stream'))return response({error:'Accept must include application/json and text/event-stream.'},406);
    const message=await readBody(request);
    if(!object(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||('id' in message&&typeof message.id!=='string'&&typeof message.id!=='number')||(message.params!==undefined&&!object(message.params)))throw new ProtocolError(-32600,'Invalid JSON-RPC request.');
    id=message.id;
    const params=message.params??{};
    const headerVersion=request.headers.get('mcp-protocol-version');
    if(headerVersion&&!PROTOCOL_VERSIONS.includes(headerVersion as any))throw new ProtocolError(-32600,'Unsupported protocol version.',400,{supported:PROTOCOL_VERSIONS});
    if(!('id' in message)){
      if(!['notifications/initialized','notifications/cancelled'].includes(message.method))throw new ProtocolError(-32600,'Unsupported notification.');
      return new Response(null,{status:202,headers:{'Cache-Control':'no-store'}});
    }
    let result:unknown;
    switch(message.method){
      case 'initialize':{
        if(typeof params.protocolVersion!=='string'||!object(params.capabilities)||!object(params.clientInfo)||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string')throw new ProtocolError(-32602,'Invalid initialization parameters.');
        result={protocolVersion:PROTOCOL_VERSIONS.includes(params.protocolVersion)?params.protocolVersion:PROTOCOL_VERSIONS[0],capabilities:{tools:{}},serverInfo:{name:'wonderworks',version:'1.0.0'},instructions:'Use explicit project IDs. Read current workspace_version before writing. Reuse the identical arguments and idempotency key after an uncertain result. Draft and submit requirement proposals; applying remains in Wonderworks. Evidence is tied to the exact saved baseline tested.'};break;
      }
      case 'ping':result={};break;
      case 'tools/list':{
        if(Object.keys(params).some(k=>!['cursor','_meta'].includes(k))||params.cursor!==undefined)throw new ProtocolError(-32602,'Invalid discovery cursor or parameters. The catalog fits one page.');
        result={tools:tools.map(t=>t.definition)};break;
      }
      case 'tools/call':{
        if(Object.keys(params).some(k=>!['name','arguments','_meta'].includes(k))||typeof params.name!=='string'||!toolMap.has(params.name))throw new ProtocolError(-32602,'Unknown tool or invalid call parameters.');
        // Sites dispatch owns OAuth and audience checks and strips/replaces
        // identity headers. This endpoint is not safe behind an untrusted proxy.
        // In portable development, the Sites middleware strips spoofed headers.
        const actorId=request.headers.get('oai-authenticated-user-id');
        const email=request.headers.get('oai-authenticated-user-email');
        if(request.headers.has('oai-sites-authorization'))return response({error:'Service access does not authorize user MCP calls.',correlation_id:correlationId},403);
        if(!actorId||!email)return response({error:'Connect the Wonderworks Site plugin to authorize this request.',correlation_id:correlationId},401);
        const client=params._meta?.['io.modelcontextprotocol/clientInfo']?.name;
        const clientName=typeof client==='string'?client.replace(/[\x00-\x1f\x7f]/g,'').slice(0,120):undefined;
        try{
          const data=await callTool(store,params.name,params.arguments??{},{id:actorId,clientName},correlationId);
          result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:false};
        }catch(error){
          const e=error instanceof ToolError?error:new ToolError('STORAGE_UNAVAILABLE','Workspace storage is unavailable. Retry the identical request and key after recovery.');
          if(!(error instanceof ToolError))console.error(JSON.stringify({event:'mcp_failure',code:e.code,correlationId,tool:params.name}));
          const data={error:{code:e.code,message:e.message,...e.details},correlation_id:correlationId};
          result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:true};
        }
        break;
      }
      default:throw new ProtocolError(-32601,'Method not found.',200);
    }
    return response({jsonrpc:'2.0',id,result});
  }catch(error){
    if(error instanceof ProtocolError)return rpcError(id,error);
    console.error(JSON.stringify({event:'mcp_failure',code:'INTERNAL_ERROR',correlationId}));
    return rpcError(id,new ProtocolError(-32603,'Unable to process request.',500,{correlation_id:correlationId}));
  }
}
