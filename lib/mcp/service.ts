import {ZodError} from 'zod';
import {normalizeTags,withTags,matchesRequirement} from '../tags';
import type {Workspace,ChangeProposal} from '../types';
import {nextId,record,requirementInput} from '../requirements';
import {recordEvidence} from '../evidence';
import {canonical,createProposal,updateProposal,getProposal,editProposalRequirement,deleteProposalRequirement,restoreProposalRequirement,submitProposal,rebaseProposal,validateSet,isStale,requirementChanges,proposalConflicts,setVersion} from '../workflow';
import {toolMap} from './contracts';
import {ToolError} from './errors';
import type {McpStore} from '../../db/mcp-store';
import {captureRequirementHistory,requirementHistory,requirementHistoryPage} from '../requirement-history';
import {firstInclusion,implementationMetadata,requireSnapshot,setSnapshotImplementation,snapshotAssociations} from '../snapshot-implementation';

export type Actor={id:string|null;clientName?:string};
export type Store=Pick<McpStore,'list'|'read'|'replay'|'commit'>;
export async function digest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');}
const versions=(doc:Workspace)=>({project_id:doc.id,workspace_version:doc.version,requirements_version:setVersion(doc)});
function summary(doc:Workspace,p:ChangeProposal){const {baseRequirements,baseSections,requirements,...metadata}=p;return {...metadata,first_included:firstInclusion(doc,p),stale:isStale(doc,p),change_count:requirementChanges(baseRequirements,requirements).length};}
function inspect(doc:Workspace,p:ChangeProposal){return {...summary(doc,p),baseRequirements:p.baseRequirements,baseSections:p.baseSections,requirements:p.requirements,changes:requirementChanges(p.baseRequirements,p.requirements),conflicts:proposalConflicts(doc,p).map(id=>({id,base:p.baseRequirements.find(r=>r.id===id)??null,proposed:p.requirements.find(r=>r.id===id)??null,latest:doc.requirements.find(r=>r.id===id)??null}))};}
function found<T>(value:T|undefined,type:string):T{if(!value)throw new ToolError('NOT_FOUND',`${type} not found in this project.`);return value;}

async function paginate<T>(items:T[],args:Record<string,unknown>,scope:unknown,revision:unknown){
  const {cursor,...query}=args;
  const queryHash=await digest({scope,query}),revisionHash=await digest(revision);
  let offset=0;
  if(cursor){
    let value;
    try{value=JSON.parse(atob(String(cursor)));}catch{throw new ToolError('INVALID_CURSOR','Invalid cursor. Restart this list without a cursor.');}
    if(!value||typeof value!=='object'||Array.isArray(value)||value.q!==queryHash||!Number.isSafeInteger(value.o)||value.o<0||Object.keys(value).sort().join(',')!=='o,q,v')throw new ToolError('INVALID_CURSOR','Cursor belongs to a different query. Restart this list.');
    if(value.v!==revisionHash)throw new ToolError('RESTART_REQUIRED','Workspace changed during pagination. Restart this list without a cursor.');
    offset=value.o;
    if(offset>items.length)throw new ToolError('INVALID_CURSOR','Cursor offset is outside this list.');
  }
  const limit=Number(args.limit??50),end=offset+limit;
  return {items:items.slice(offset,end),...(end<items.length?{next_cursor:btoa(JSON.stringify({q:queryHash,v:revisionHash,o:end}))}:{})};
}

export function stage(doc:Workspace,proposalId:string,operations:any[]){
  const p=getProposal(doc,proposalId,true),refs:Record<string,string>={};
  // Allocate all new IDs first so forward references inside this atomic batch work.
  for(const op of operations)if(op.op==='add'){
    if(Object.hasOwn(refs,op.client_ref))throw new ToolError('VALIDATION_ERROR','Duplicate client_ref.',{client_ref:op.client_ref});
    Object.defineProperty(refs,op.client_ref,{value:nextId(doc),enumerable:true});
  }
  const links=(values:string[])=>values.map(id=>id.startsWith('$')?found(Object.hasOwn(refs,id.slice(1))?refs[id.slice(1)]:undefined,'Batch client_ref'):id);
  for(const op of operations){
    if(op.op==='add'){
      const data=requirementInput.parse({...op.requirement,links:links(op.requirement.links)});
      if(!doc.sections.some(s=>s.id===data.section))throw new ToolError('VALIDATION_ERROR','Choose an existing section.',{section:data.section});
      p.requirements.push({...data,tags:data.tags??[],id:refs[op.client_ref],revision:1});
    }else if(op.op==='edit')editProposalRequirement(doc,p.id,{...op.requirement,id:op.requirement_id,links:links(op.requirement.links)});
    else if(op.op==='delete')deleteProposalRequirement(doc,p.id,op.requirement_id);
    else {
      if(!p.requirements.some(r=>r.id===op.requirement_id)&&!p.baseRequirements.some(r=>r.id===op.requirement_id))throw new ToolError('NOT_FOUND','Requirement is not in this proposal.',{requirement_id:op.requirement_id});
      restoreProposalRequirement(doc,p.id,op.requirement_id);
    }
  }
  validateSet(doc,p.requirements);p.updatedAt=new Date().toISOString();return refs;
}

export async function callTool(store:Store,name:string,raw:unknown,actor:Actor,correlationId:string,now=Date.now()):Promise<Record<string,unknown>>{
  const definition=toolMap.get(name);
  if(!definition)throw new ToolError('UNKNOWN_TOOL','Unknown tool.');
  const parsed=definition.input.safeParse(raw);
  if(!parsed.success)throw new ToolError('VALIDATION_ERROR',name==='set_snapshot_implementation'?'Check the implementation reference.':'Invalid tool arguments.',{fields:parsed.error.issues.map(i=>({path:i.path.join('.'),message:i.message}))});
  const args=parsed.data as Record<string,any>;
  if(name==='list_requirements')args.tags=normalizeTags(args.tags);
  if(name==='list_projects'){
    const projects=await store.list();
    return paginate(projects.map(p=>({id:p.id,name:p.name,workspace_version:p.version})),args,{name,actor:actor.id},projects);
  }
  const doc=await store.read(args.project_id);
  if(definition.definition.annotations.readOnlyHint){
    const v=versions(doc);
    switch(name){
      case 'get_project':return {...v,id:doc.id,name:doc.name,prefix:doc.prefix,sections:doc.sections,repositories:doc.repositories??[]};
      case 'get_requirement':return {...v,requirement:withTags(found(doc.requirements.find(r=>r.id===args.requirement_id),'Requirement')),lifecycle:requirementHistory(doc,args.requirement_id).lifecycle,coverage:requirementHistory(doc,args.requirement_id).coverage};
      case 'get_requirement_history':return requirementHistoryPage(doc,args.requirement_id,args);
      case 'get_snapshot':return {...v,snapshot:requireSnapshot(doc,args.baseline_id),associations:snapshotAssociations(doc,args.baseline_id)};
      case 'get_snapshot_implementation_history':{
        requireSnapshot(doc,args.baseline_id);
        return {...v,baseline_id:args.baseline_id,...implementationMetadata(doc,args.baseline_id),...await paginate([...(doc.snapshotImplementations?.[args.baseline_id]?.history??[])].reverse(),args,{name,actor:actor.id},doc.version)};
      }
      case 'get_proposal':return {...v,proposal:inspect(doc,found(doc.proposals?.find(p=>p.id===args.proposal_id),'Proposal'))};
      default:{
        let items:unknown[]=[];
        if(name==='list_requirements')items=doc.requirements.filter(r=>matchesRequirement(r,args)).map(withTags);
        if(name==='list_snapshots')items=doc.baselines.map(({requirements,sections,repositories,...meta})=>({...meta,...implementationMetadata(doc,meta.id)}));
        if(name==='list_proposals')items=(doc.proposals??[]).map(p=>summary(doc,p));
        if(name==='list_evidence')items=doc.evidence.filter(e=>!args.baseline_id||e.baseline===args.baseline_id);
        return {...v,...await paginate(items,args,{name,actor:actor.id},doc.version)};
      }
    }
  }
  const key=await digest({actor:actor.id,project:doc.id,name,key:args.idempotency_key});
  // Hash original arguments, including expected version, to forbid a different
  // operation under the same retry key. Check replay before the version gate.
  const fingerprint=await digest(raw),replay=await store.replay(key,fingerprint,now);
  if(replay)return replay;
  if(args.expected_workspace_version!==doc.version)throw new ToolError('CONFLICT','Workspace changed. Reload the project before making a new write.',{current_workspace_version:doc.version});
  const result:Record<string,unknown>={...versions(doc),workspace_version:doc.version+1,correlation_id:correlationId};
  let objectIds:string[]=[];
  let unchanged=false;
  const original=structuredClone(doc),history=structuredClone(doc.history);
  try{
    switch(name){
      case 'set_snapshot_implementation':{
        unchanged=!setSnapshotImplementation(doc,args.baseline_id,args.implementation_commit,{id:actor.id,...(actor.clientName?{reportedClientName:actor.clientName}:{})},new Date(now).toISOString());
        Object.assign(result,{baseline_id:args.baseline_id,...implementationMetadata(doc,args.baseline_id),workspace_version:doc.version+(unchanged?0:1)});
        objectIds=[args.baseline_id];break;
      }
      case 'create_proposal':{const p=createProposal(doc,args);result.proposal_id=p.id;result.status=p.status;objectIds=[p.id];break;}
      case 'update_proposal':updateProposal(doc,args.proposal_id,args);break;
      case 'stage_proposal_changes':{const refs=stage(doc,args.proposal_id,args.operations);result.client_refs=refs;objectIds=[...Object.values(refs),...args.operations.flatMap((op:any)=>op.requirement_id?[op.requirement_id]:[])];break;}
      case 'submit_proposal':{
        const p=getProposal(doc,args.proposal_id);
        if(isStale(doc,p))throw new ToolError('STALE_PROPOSAL','Refresh this proposal before submitting.',{latest_requirements_version:setVersion(doc),conflicts:proposalConflicts(doc,p)});
        submitProposal(doc,args.proposal_id);break;
      }
      case 'rebase_proposal':{
        const p=getProposal(doc,args.proposal_id),conflicts=proposalConflicts(doc,p);
        if(conflicts.some(id=>!Object.hasOwn(args.resolutions,id)))throw new ToolError('REBASE_CONFLICT','Choose proposed or latest for every conflict.',{conflicts,latest_requirements_version:setVersion(doc)});
        if(Object.keys(args.resolutions).some(id=>!conflicts.includes(id)))throw new ToolError('VALIDATION_ERROR','Resolutions must identify current conflicts only.');
        rebaseProposal(doc,args.proposal_id,args.resolutions);break;
      }
      case 'record_evidence':{const e=recordEvidence(doc,args.evidence);Object.assign(result,{evidence_id:e.id,baseline_id:e.baseline,date:e.date});objectIds=[e.id,e.baseline,...e.checks.map(c=>c.id)];break;}
      default:throw new ToolError('UNKNOWN_TOOL','Unknown mutating tool.');
    }
    if(args.proposal_id){const p=getProposal(doc,args.proposal_id);Object.assign(result,{proposal_id:p.id,status:p.status});objectIds.unshift(p.id);}
  }catch(error){
    if(error instanceof ToolError)throw error;
    if(error instanceof ZodError)throw new ToolError('VALIDATION_ERROR','Invalid requirement or evidence.',{fields:error.issues.map(i=>({path:i.path.join('.'),message:i.message}))});
    // Domain helpers contain user-correctable rules only; storage is outside this catch.
    throw new ToolError('VALIDATION_ERROR',error instanceof Error?error.message:'Invalid workflow operation.');
  }
  // One attributable event per atomic write, including on a large staged batch.
  doc.history=history;
  if(!unchanged){
  record(doc,`MCP ${name} · ${[...new Set(objectIds)].join(', ')}`,name==='stage_proposal_changes'?objectIds.filter(id=>id!==args.proposal_id):undefined);
  doc.history[0].mcp={actorId:actor.id??'unknown',...(actor.clientName?{clientName:actor.clientName}:{}),tool:name,projectId:doc.id,objectIds:[...new Set(objectIds)],correlationId};
  if(name==='set_snapshot_implementation'){
    doc.history[0].snapshotImplementation=structuredClone(doc.snapshotImplementations![args.baseline_id].history.at(-1)!);
    doc.history[0].date=doc.snapshotImplementations![args.baseline_id].updated_at;
    doc.history[0].message=`Implementation commit ${args.implementation_commit?'recorded':'cleared'} · ${args.baseline_id}`;
  }
  captureRequirementHistory(original,doc,{source:name,actor:{id:actor.id,...(actor.clientName?{reportedClientName:actor.clientName}:{})}});
  }
  definition.output.parse(result);
  return store.commit(doc,args.expected_workspace_version,{key,project:doc.id,fingerprint,result,expiresAt:now+24*60*60*1000},now,unchanged);
}
