import {z} from 'zod';
import {database} from '@/db/runtime';
import {deleteWorkspace,DeletionError} from '@/db/workspace-deletion';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const schema=z.object({project_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),expected_workspace_version:z.number().int().nonnegative().safe(),idempotency_key:z.string().min(16).max(128)}).strict();
export async function POST(request:Request){
  // The deployment gateway verifies and replaces identity headers. A Sites
  // service bypass is not a user and cannot authorize project destruction.
  const actor=request.headers.has('oai-sites-authorization')?null:request.headers.get('oai-authenticated-user-id');
  if(!actor)return Response.json({error:'Sign in to manage this workspace.'},{status:401,headers});
  try{
    const origin=request.headers.get('origin');if(origin&&new URL(origin).origin!==new URL(request.url).origin)return Response.json({error:'Origin rejected.'},{status:403,headers});
    const text=await request.text();if(text.length>250000)return Response.json({error:'Request is too large.'},{status:413,headers});
    const input=schema.parse(JSON.parse(text));
    return Response.json(await deleteWorkspace(database(),input,actor),{headers});
  }catch(error){
    if(error instanceof DeletionError)return Response.json({error:error.message,...(error.version===undefined?{}:{current_workspace_version:error.version})},{status:error.status,headers});
    if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof TypeError)return Response.json({error:'Provide an explicit project ID, confirmed workspace version, and retry key.'},{status:400,headers});
    return Response.json({error:'Deletion was not acknowledged. Retry with the same confirmation and key after storage recovers.'},{status:503,headers});
  }
}
