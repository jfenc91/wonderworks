import {readWorkspace,saveWorkspace,listWorkspaces,createWorkspace} from '@/db/workspace';
import {upsert,record,validateDependencies,reconcileWorkspace} from '@/lib/requirements';
import {saveRepository,createProposal,updateProposal,editProposalRequirement,deleteProposalRequirement,restoreProposalRequirement,submitProposal,rebaseProposal,reviewProposal,snapshot,setContent,setVersion} from '@/lib/workflow';
import {z} from 'zod';
import {recordEvidence} from '@/lib/evidence';
import {captureRequirementHistory} from '@/lib/requirement-history';
export const dynamic='force-dynamic';

export async function GET(request:Request){
  try{
    const url=new URL(request.url);
    return Response.json(url.searchParams.has('index')?await listWorkspaces():await readWorkspace(url.searchParams.get('project')??'asteroids'),{headers:{'Cache-Control':'no-store'}});
  }catch(error){console.error(error);return Response.json({error:'Workspace storage is unavailable. Please try again.'},{status:503});}
}
export async function POST(request:Request){
  try{
    const origin=request.headers.get('origin');
    if(origin&&new URL(origin).host!==new URL(request.url).host)return Response.json({error:'Origin rejected'},{status:403});
    const text=await request.text();
    if(text.length>250000)return Response.json({error:'Request is too large'},{status:413});
    const input=JSON.parse(text);
    if(input.action==='project'){
      const p=z.object({name:z.string().trim().min(2).max(80),prefix:z.string().regex(/^[A-Z]{2,6}$/)}).parse(input);
      return Response.json(await createWorkspace(p.name,p.prefix));
    }
    const doc=await readWorkspace(input.project??'asteroids');
    if(input.version!==doc.version)return Response.json({error:'This workspace changed in another session. Reload before saving.'},{status:409});
    const original=structuredClone(doc),before=setContent(doc),previousVersion=setVersion(doc);
    switch(input.action){
      case 'import':reconcileWorkspace(doc,input.workspace);break;
      case 'repository':saveRepository(doc,input.repository);break;
      case 'repository_remove':{
        const repository=doc.repositories?.find(r=>r.id===input.id);
        if(!repository)throw Error('Repository link not found');
        doc.repositories=doc.repositories?.filter(r=>r.id!==input.id);
        record(doc,`Repository unlinked · ${repository.name}`);break;
      }
      case 'proposal':createProposal(doc,input.proposal);break;
      case 'proposal_update':updateProposal(doc,input.id,input.proposal);break;
      case 'proposal_requirement':editProposalRequirement(doc,input.id,input.requirement);break;
      case 'proposal_delete':deleteProposalRequirement(doc,input.id,input.requirementId);break;
      case 'proposal_restore':restoreProposalRequirement(doc,input.id,input.requirementId);break;
      case 'proposal_submit':submitProposal(doc,input.id);break;
      case 'proposal_rebase':rebaseProposal(doc,input.id,input.resolutions);break;
      case 'proposal_review':reviewProposal(doc,input.id,input.review);break;
      case 'section':{
        const section=z.object({id:z.string().optional(),title:z.string().trim().min(2).max(70),description:z.string().max(300)}).parse(input.section);
        if(section.id){const old=doc.sections.find(s=>s.id===section.id);if(!old)throw Error('Section no longer exists');Object.assign(old,section);}
        else doc.sections.push({...section,id:crypto.randomUUID()});
        record(doc,`Section ${section.id?'updated':'created'} · ${section.title}`);break;
      }
      case 'requirements':
        if(!Array.isArray(input.requirements)||input.requirements.length>100)throw Error('Provide up to 100 requirements');
        for(const r of input.requirements)upsert(doc,r);
        validateDependencies(doc);break;
      case 'delete':{
        const req=doc.requirements.find(r=>r.id===input.id);if(!req)throw Error('Requirement not found');
        if(doc.requirements.some(r=>r.links.includes(req.id)))throw Error('Remove dependent links before deleting this requirement');
        doc.requirements=doc.requirements.filter(r=>r.id!==req.id);record(doc,`${req.id} deleted · ${req.title}`,[req.id]);break;
      }
      case 'baseline':snapshot(doc,input.name);break;
      case 'evidence':recordEvidence(doc,input.evidence);break;
      default:throw Error('Unknown workspace action');
    }
    if(setContent(doc)!==before && setVersion(doc)===previousVersion)doc.requirementsVersion=previousVersion+1;
    captureRequirementHistory(original,doc,{source:input.action,actor:{id:request.headers.has('oai-sites-authorization')?null:request.headers.get('oai-authenticated-user-id')}});
    return Response.json(await saveWorkspace(doc,doc.version));
  }catch(error){
    if(error instanceof Error&&error.message==='CONFLICT')return Response.json({error:'This workspace changed in another session. Reload before saving.'},{status:409});
    if(error instanceof z.ZodError)return Response.json({error:error.issues.map(i=>i.path.join('.')+': '+i.message).join('; ')},{status:400});
    console.error(error);return Response.json({error:error instanceof Error?error.message:'Unable to save changes'},{status:400});
  }
}
