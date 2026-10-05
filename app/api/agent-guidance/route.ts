import {database} from '@/db/runtime';
import {McpStore} from '@/db/mcp-store';
import {saveGuidance} from '@/lib/guidance-settings';
import {originAllowed,readBody} from '@/lib/mcp/http';
import {ToolError,ProtocolError} from '@/lib/mcp/errors';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const headers={'Cache-Control':'no-store'};
 if(!originAllowed(request))return Response.json({error:'Origin rejected.'},{status:403,headers});
 try{
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return Response.json({error:'Content-Type must be application/json.'},{status:415,headers});
  return Response.json(await saveGuidance(new McpStore(database()),await readBody(request),{id:request.headers.has('oai-sites-authorization')?null:request.headers.get('oai-authenticated-user-id')}),{headers});
 }catch(error){
  if(error instanceof ToolError)return Response.json({error:{code:error.code,message:error.message,...error.details}},{headers,status:error.code==='NOT_FOUND'?404:['CONFLICT','IDEMPOTENCY_KEY_REUSED'].includes(error.code)?409:400});
  if(error instanceof ProtocolError)return Response.json({error:error.message},{headers,status:error.status});
  return Response.json({error:'Guidance storage unavailable. Retry the identical request and key.'},{headers,status:503});
 }
}
