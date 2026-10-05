import {database} from '@/db/runtime';
import {readStoredRecord} from '@/db/workspace-records';
import {captureArchive,completeArchive,decodeArchive,ARCHIVE_LIMITS} from '@/lib/workspace-archive';
import {previewArchive,importArchive,type ImportSelection} from '@/db/archive-store';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
function actor(request:Request){if(request.headers.has('oai-sites-authorization'))return null;return request.headers.get('oai-authenticated-user-id');}
export async function GET(request:Request){
  if(!actor(request))return Response.json({error:'Sign in to export private workspaces.'},{status:401,headers});
  try{
    const url=new URL(request.url),db=database();
    if(url.searchParams.has('provenance')){const id=url.searchParams.get('provenance')!;const row=await db.prepare('SELECT data FROM workspace_provenance WHERE project=?').bind(id).first<{data:string}>();return Response.json(row?await readStoredRecord(db,id,row.data):null,{headers});}
    const scope=url.searchParams.get('scope');if(!scope)throw Error('Choose the current project or all accessible workspaces.');
    const archive=await captureArchive(db,scope,request.signal);
    const file=await completeArchive(archive,request.signal);
    return new Response(file,{headers:{...headers,'Content-Type':'application/zip','Content-Length':String(file.size),'Content-Disposition':'attachment; filename="wonderworks-workspaces.wwspace"','X-Workspace-Count':String(archive.manifest.projects.length),'X-Workspace-Versions':JSON.stringify(archive.manifest.projects.map(p=>({id:p.id,version:p.version})))}});
  }catch{return Response.json({error:'Workspace export failed or exceeds its limits. Retry with fewer projects after checking storage.'},{status:400,headers});}
}
export async function POST(request:Request){
  const user=actor(request);if(!user)return Response.json({error:'Sign in to import workspaces.'},{status:401,headers});
  const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)return Response.json({error:'Origin rejected.'},{status:403,headers});
  if(Number(request.headers.get('content-length'))>ARCHIVE_LIMITS.compressed)return Response.json({error:'Archive exceeds 32 MiB.'},{status:413,headers});
  try{
    if(!request.body)throw Error('Upload a .wwspace file.');
    const archive=await decodeArchive(request.body,request.signal),db=database();
    if(new URL(request.url).searchParams.get('action')==='preview')return Response.json(await previewArchive(db,archive),{headers});
    const action=new URL(request.url).searchParams.get('action');
    if(action!=='import'&&action!=='restore-empty')throw Error('Choose preview or import.');
    const raw=request.headers.get('x-workspace-selection')??'';if(raw.length>16000)throw Error('Selection too large.');
    const selections=JSON.parse(raw) as ImportSelection[];
    if(action==='restore-empty'&&(selections.length!==archive.manifest.projects.length||selections.some(s=>s.mode!=='restore')))throw Error('Administrative restore requires every archived project in restore mode.');
    return Response.json(await importArchive(db,archive,selections,user,request.headers.get('x-workspace-operation')??'',request.signal,{emptyOnly:action==='restore-empty'}),{headers});
  }catch(error){
    // Archive validation messages contain field categories, never content or SQL.
    const allowed=/^(?:Transfer cancelled|Select archived|Import operation|A destination|Unsupported|Invalid|Missing|Duplicate|Archive |Workspace |Storage version checksum|Incomplete|Upload |Choose |Selection|Administrative)/;
    const message=error instanceof Error&&allowed.test(error.message)?error.message:'Import could not complete. Existing workspaces are unchanged. Retry with the same file, selection and operation ID.';
    return Response.json({error:message},{status:400,headers});
  }
}
