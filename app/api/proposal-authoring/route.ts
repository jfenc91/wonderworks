import {env} from 'cloudflare:workers';
import {McpStore} from '@/db/mcp-store';
import {authorRequirements} from '@/lib/proposal-authoring';
import {originAllowed,readBody} from '@/lib/mcp/http';
import {ToolError,ProtocolError} from '@/lib/mcp/errors';
export const dynamic='force-dynamic';

export async function POST(request:Request){
  const headers={'Cache-Control':'no-store'};
  if(!originAllowed(request))return Response.json({error:'Origin rejected.'},{status:403,headers});
  try{
    if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return Response.json({error:'Content-Type must be application/json.'},{status:415,headers});
    const actor={id:request.headers.has('oai-sites-authorization')?null:request.headers.get('oai-authenticated-user-id')};
    return Response.json(await authorRequirements(new McpStore(env.DB),await readBody(request),actor),{headers});
  }catch(error){
    if(error instanceof ToolError)return Response.json({error:{code:error.code,message:error.message,...error.details}},{headers,status:error.code==='NOT_FOUND'?404:['CONFLICT','IDEMPOTENCY_KEY_REUSED'].includes(error.code)?409:400});
    if(error instanceof ProtocolError)return Response.json({error:error.message},{headers,status:error.status});
    return Response.json({error:'Storage unavailable. Retry the identical save to recover its result.'},{headers,status:503});
  }
}
