import {env} from 'cloudflare:workers';
import {migrateWorkspaceStorage} from '@/db/workspace-records';
import {originAllowed,readBody} from '@/lib/mcp/http';
import {z} from 'zod';
export const dynamic='force-dynamic';
// Maintenance uses the same Sites audience boundary as /api/workspace. It
// changes only physical representation, never the logical workspace/version.
export async function POST(request:Request){
 const headers={'Cache-Control':'no-store'};
 if(!originAllowed(request))return Response.json({error:'Origin rejected'},{status:403,headers});
 try{
  if(!env.DB)throw Error('Storage unavailable');
  const input=z.object({project_id:z.string().min(1),expected_workspace_version:z.number().int().nonnegative()}).strict().parse(await readBody(request));
  return Response.json(await migrateWorkspaceStorage(env.DB,input.project_id,input.expected_workspace_version),{headers});
 }catch(e){
  if(e instanceof z.ZodError)return Response.json({error:'Invalid migration request'},{status:400,headers});
  if(e instanceof Error&&e.message==='CONFLICT')return Response.json({error:'Workspace changed; reload before migrating.'},{status:409,headers});
  console.error(JSON.stringify({event:'storage_migration_failed',errorName:e instanceof Error?e.name:'unknown'}));
  return Response.json({error:'Migration did not complete. The previous committed workspace remains available.'},{status:503,headers});
 }
}
