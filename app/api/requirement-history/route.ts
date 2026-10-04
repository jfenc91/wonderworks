import {readWorkspace} from '@/db/workspace';
import {requirementHistoryPage} from '@/lib/requirement-history';
import {ToolError} from '@/lib/mcp/errors';
export const dynamic='force-dynamic';

export async function GET(request:Request){
  const headers={'Cache-Control':'no-store'};
  // The same Sites audience boundary protects the UI and every data endpoint.
  // Service requests may use the existing hosting service access path.
  try{
    const url=new URL(request.url),project=url.searchParams.get('project_id'),id=url.searchParams.get('requirement_id');
    if(!project||!id||!/^[A-Z]{2,6}-\d{3,6}$/.test(id))throw new ToolError('VALIDATION_ERROR','Provide explicit project_id and requirement_id.');
    const cursor=url.searchParams.get('cursor')??undefined;
    if(cursor&&cursor.length>2000)throw new ToolError('INVALID_CURSOR','Invalid history cursor. Restart without a cursor.');
    const result=await requirementHistoryPage(await readWorkspace(project),id,{cursor,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):undefined});
    return Response.json(result,{headers});
  }catch(error){
    if(error instanceof ToolError)return Response.json({error:{code:error.code,message:error.message}},{headers,status:error.code==='NOT_FOUND'?404:error.code==='RESTART_REQUIRED'?409:400});
    if(error instanceof Error&&error.message==='Workspace not found')return Response.json({error:{code:'NOT_FOUND',message:'Project not found.'}},{headers,status:404});
    console.error(error);return Response.json({error:{code:'STORAGE_UNAVAILABLE',message:'History is unavailable. Please retry.'}},{headers,status:503});
  }
}
