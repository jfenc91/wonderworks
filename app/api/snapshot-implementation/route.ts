import {env} from 'cloudflare:workers';
import {McpStore} from '@/db/mcp-store';
import {callTool} from '@/lib/mcp/service';
import {originAllowed,readBody} from '@/lib/mcp/http';
import {ToolError,ProtocolError} from '@/lib/mcp/errors';
export const dynamic='force-dynamic';

// Inherits the existing Sites application audience boundary. Identity headers
// are supplied by Sites (and stripped/emulated only on loopback in development).
async function handle(request:Request){
  const headers={'Cache-Control':'no-store'},correlationId=crypto.randomUUID();
  if(!originAllowed(request))return Response.json({error:{code:'FORBIDDEN',message:'Origin rejected.'}},{status:403,headers});
  try{
    let name='set_snapshot_implementation',args:unknown;
    if(request.method==='GET'){
      const url=new URL(request.url);
      name=url.searchParams.get('history')==='1'?'get_snapshot_implementation_history':'get_snapshot';
      args={project_id:url.searchParams.get('project_id'),baseline_id:url.searchParams.get('baseline_id'),...(name.endsWith('_history')?{...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{}),...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')}:{})}:{})};
    }else{
      if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return Response.json({error:{code:'VALIDATION_ERROR',message:'Content-Type must be application/json.'}},{status:415,headers});
      args=await readBody(request);
    }
    const actor={id:request.headers.has('oai-sites-authorization')?null:request.headers.get('oai-authenticated-user-id')};
    return Response.json(await callTool(new McpStore(env.DB),name,args,actor,correlationId),{headers});
  }catch(error){
    if(error instanceof ToolError)return Response.json({error:{code:error.code,message:error.message,...error.details},correlation_id:correlationId},{headers,status:error.code==='NOT_FOUND'?404:['CONFLICT','RESTART_REQUIRED','IDEMPOTENCY_KEY_REUSED'].includes(error.code)?409:400});
    if(error instanceof ProtocolError)return Response.json({error:{code:'VALIDATION_ERROR',message:error.message}},{headers,status:error.status});
    console.error(JSON.stringify({event:'snapshot_implementation_failure',correlationId}));
    return Response.json({error:{code:'STORAGE_UNAVAILABLE',message:'Unable to save or read implementation metadata. Retry the identical request and key.'},correlation_id:correlationId},{headers,status:503});
  }
}
export const GET=handle;
export const POST=handle;
