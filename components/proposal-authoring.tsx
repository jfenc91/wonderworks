'use client';
import {forwardRef,useImperativeHandle,useRef,useState} from 'react';
import {Sheet,SheetContent,SheetTitle,SheetDescription} from '@/components/ui/sheet';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {TagEditor,type TagEditorHandle} from '@/components/requirement-tags';
import {canonical,isStale,sameRequirement} from '@/lib/workflow';
import {tagsOf,tagInventory} from '@/lib/tags';
import type {Workspace,Requirement,ChangeProposal} from '@/lib/types';

export type AuthoringSession={base:Workspace;contextId:string;initial:Partial<Requirement>};
export type AuthoringHandle={navigate:(next:()=>void)=>void};
type Props={doc:Workspace;session:AuthoringSession;busy:boolean;mutate:(action:string,data:Record<string,unknown>,base:Workspace)=>Promise<Workspace>;onClose:()=>void;onSaved:(proposal:ChangeProposal,requirementId:string,close:boolean)=>void};
const source=(doc:Workspace,context:string,id?:string)=>(context?doc.proposals?.find(p=>p.id===context)?.requirements:doc.requirements)?.find(r=>r.id===id);
export function proposalLabel(doc:Workspace,p:ChangeProposal){return `${p.id} · ${p.title} · ${p.status} · Base v${p.baseVersion}${isStale(doc,p)?' · Stale':''}`;}
function Content({value}:{value:unknown}){return <pre className="authoring-content">{JSON.stringify(value??'Not present',null,2)}</pre>;}

export const ProposalAuthoring=forwardRef<AuthoringHandle,Props>(function ProposalAuthoring({doc,session,busy,mutate,onClose,onSaved},ref){
  const [base,setBase]=useState(session.base),[origin,setOrigin]=useState({contextId:session.contextId,requirement:session.initial});
  const [draft,setDraft]=useState(session.initial),[criteria,setCriteria]=useState(session.initial.criteria?.join('\n')??''),[parameters,setParameters]=useState(JSON.stringify(session.initial.parameters??{},null,2)),[links,setLinks]=useState(session.initial.links?.join(', ')??'');
  const [target,setTarget]=useState(session.contextId),[picker,setPicker]=useState(false),[title,setTitle]=useState(''),[description,setDescription]=useState(''),[intent,setIntent]=useState<'save'|'delete'>('save'),[confirmDelete,setConfirmDelete]=useState(false),[error,setError]=useState(''),[resolved,setResolved]=useState(''),[switching,setSwitching]=useState(false),[uncertain,setUncertain]=useState(false);
  const navigation=useRef<(()=>void)|null>(null),navigationSave=useRef(false),tags=useRef<TagEditorHandle>(null),form=useRef<HTMLFormElement>(null),inputEpoch=useRef(0);
  const pending=useRef<{args:Record<string,unknown>;signature:string;epoch:number;intent:'save'|'delete';target:string}|null>(null);
  const signature=canonical({draft,criteria,parameters,links});
  const latestSignature=useRef(signature);latestSignature.current=signature;
  const initialSignature=useRef(signature);
  function navigate(next:()=>void){if(latestSignature.current!==initialSignature.current||inputEpoch.current>0||pending.current){navigation.current=next;navigationSave.current=false;setSwitching(true);}else next();}
  useImperativeHandle(ref,()=>({navigate}));
  const destination=doc.proposals?.find(p=>p.id===target),creating=target==='new';
  const latestSource=source(doc,origin.contextId,origin.requirement.id);
  const destinationSource=creating?doc.requirements.find(r=>r.id===draft.id):destination?.requirements.find(r=>r.id===draft.id);
  const sourceMissing=!!draft.id&&!latestSource;
  const unavailable=target&&!creating&&(!destination||destination.status!=='Draft');
  const missing=!!draft.id&&!!target&&!destinationSource;
  const differs=!!draft.id&&!!destinationSource&&!sameRequirement(origin.requirement as Requirement,destinationSource);
  const conflictKey=canonical({target,destinationSource});
  const conflict=differs&&resolved!==conflictKey;
  const stale=base.version!==doc.version||base.id!==doc.id;
  const blocked=busy||stale||!!unavailable||sourceMissing||missing||conflict||!target||uncertain;
  const pendingContent={...draft,criteria:criteria.split('\n').filter(Boolean),parameters,links};
  function choose(value:string){setTarget(value);setResolved('');setError('');}
  function cancelPicker(){setPicker(false);setConfirmDelete(false);navigation.current=null;}
  function begin(action:'save'|'delete'){
    if(action==='save'&&!form.current?.reportValidity())return;
    setError('');setIntent(action);
    if(!target||unavailable){setPicker(true);return;}
    if(action==='delete'){setConfirmDelete(true);return;}
    void save(action);
  }
  async function save(action:'save'|'delete',retry=false){
    setError('');
    try{
      if(!retry){
        if(blocked)throw Error('Review the source and destination before saving. Your input is preserved.');
        let operations;
        if(action==='delete')operations=[{op:'delete',requirement_id:draft.id}];
        else{
          const values=JSON.parse(parameters);
          if(!values||Array.isArray(values)||typeof values!=='object')throw Error('Parameters must be a JSON object.');
          const {id,revision,...fields}=draft;
          const requirement={...fields,tags:tags.current?.readTags()??tagsOf(draft),criteria:criteria.split('\n').map(s=>s.trim()).filter(Boolean),parameters:values,links:links.split(',').map(s=>s.trim()).filter(Boolean)};
          operations=[id?{op:'edit',requirement_id:id,requirement}:{op:'add',client_ref:'pending',requirement}];
        }
        pending.current={args:{project_id:base.id,expected_workspace_version:base.version,idempotency_key:crypto.randomUUID(),...(creating?{new_proposal:{title,description}}:{proposal_id:target}),operations},signature,epoch:inputEpoch.current,intent:action,target};
      }
      const request=pending.current!;
      const result=await mutate('author_requirements',request.args,base);
      const p=request.target==='new'?result.proposals![0]:result.proposals!.find(p=>p.id===request.target)!;
      const id=draft.id??p.requirements.at(-1)?.id??'';
      const unchanged=latestSignature.current===request.signature&&inputEpoch.current===request.epoch;
      pending.current=null;setUncertain(false);setPicker(false);setConfirmDelete(false);
      onSaved(p,request.intent==='delete'?'':id,unchanged);
      if(unchanged){const next=navigationSave.current?navigation.current:null;navigation.current=null;next?.();}
      else{
        // An acknowledged save can establish a new edit base; later read-model
        // versions still require reconciliation. Preserve input typed in flight.
        setBase(result);setTarget(p.id);setDraft(value=>({...value,id}));
        setOrigin({contextId:p.id,requirement:p.requirements.find(r=>r.id===id)??draft});
        setError('The submitted values were staged. Your newer input is still here and has not been saved.');
        navigation.current=null;
      }
    }catch(e){
      const status=(e as {status?:number}).status;
      if(pending.current&&(status===undefined||status>=500)){setUncertain(true);setError('The save outcome is uncertain. Retry the original save to recover its result; your current input is preserved.');}
      else{pending.current=null;setUncertain(false);setError(e instanceof Error?e.message:'Unable to stage this change.');}
    }
  }
  const comparison=<>{stale&&<section className="edit-conflict" role="status"><strong>Newer saved workspace available</strong><p>Your edit began at revision {base.version}; the saved workspace is now revision {doc.version}. Compare the saved source and destination with your pending input.</p><details><summary>Original source</summary><Content value={origin.requirement}/></details><details><summary>Latest saved source</summary><Content value={latestSource}/></details><details><summary>Latest destination content</summary><Content value={destinationSource}/></details><button type="button" className="secondary" disabled={busy||uncertain||sourceMissing} onClick={()=>{setBase(doc);setResolved('');}}>I reviewed latest; keep my input</button></section>}
    {sourceMissing&&<div className="error-box" role="status">The source requirement was removed. It cannot be silently recreated. Your input is preserved.<button type="button" className="secondary" disabled={busy||uncertain} onClick={()=>{setDraft(value=>({...value,id:undefined,revision:undefined}));setOrigin(value=>({...value,requirement:{...value.requirement,id:undefined}}));setResolved('');}}>Use pending input as a new requirement</button></div>}
    {unavailable&&<div className="error-box" role="status">{target} is {destination?.status??'unavailable'} and cannot receive edits. Choose another Draft or create a new proposal.</div>}
    {missing&&!sourceMissing&&<div className="error-box" role="status">{draft.id} is absent from this destination. Choose another proposal or restore it through Changes before editing. This save cannot resurrect it.</div>}
    {conflict&&<section className="edit-conflict"><strong>This destination has different saved content</strong><p>Compare your pending input with the staged requirement before replacing it.</p><details open><summary>Saved destination</summary><Content value={destinationSource}/></details><details><summary>Pending input</summary><Content value={pendingContent}/></details><button type="button" className="secondary" disabled={busy||uncertain} onClick={()=>setResolved(conflictKey)}>Use my pending values in this proposal</button></section>}</>;
  return <>
    <Sheet open modal={false} onOpenChange={open=>{if(!open)navigate(onClose);}}><SheetContent className="requirement-editor" onInteractOutside={e=>e.preventDefault()}><SheetTitle>{draft.id?'Edit '+draft.id:'New requirement'}</SheetTitle><SheetDescription>{session.contextId?proposalLabel(doc,doc.proposals?.find(p=>p.id===session.contextId)??session.base.proposals!.find(p=>p.id===session.contextId)!):'Latest accepted requirements'} · Saves are staged for review.</SheetDescription>
      <form ref={form} className="editor-form" onInput={()=>inputEpoch.current++} onSubmit={e=>{e.preventDefault();begin('save');}}>
        {!picker&&comparison}
        <label>Title<input required minLength={3} maxLength={120} value={draft.title??''} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <label>Section<select aria-label="Requirement section" value={draft.section??''} onChange={e=>setDraft({...draft,section:e.target.value})}>{doc.sections.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
        <div className="form-grid"><label>Priority<select aria-label="Priority" value={draft.priority??'High'} onChange={e=>setDraft({...draft,priority:e.target.value as Requirement['priority']})}>{['Critical','High','Medium'].map(v=><option key={v}>{v}</option>)}</select></label><label>Status<select aria-label="Status" value={draft.status??'Draft'} onChange={e=>setDraft({...draft,status:e.target.value as Requirement['status']})}>{['Draft','Approved','Implemented'].map(v=><option key={v}>{v}</option>)}</select></label></div>
        <label>Description<textarea required minLength={10} maxLength={4000} rows={5} value={draft.description??''} onChange={e=>setDraft({...draft,description:e.target.value})}/></label>
        <label>Acceptance criteria<span className="field-hint">One measurable outcome per line</span><textarea required rows={5} value={criteria} onChange={e=>setCriteria(e.target.value)}/></label>
        <TagEditor ref={tags} value={tagsOf(draft)} suggestions={tagInventory(destination?.requirements??doc.requirements).map(i=>i.tag)} onChange={tags=>setDraft({...draft,tags})}/>
        <label>Dependencies<span className="field-hint">IDs in the destination proposal, separated by commas</span><input value={links} onChange={e=>setLinks(e.target.value)}/></label>
        <details><summary>Specified parameters</summary><textarea aria-label="Requirement parameters JSON" className="code-input" rows={5} value={parameters} onChange={e=>setParameters(e.target.value)}/></details>
        <div className="authoring-destination"><strong>Save destination</strong><p>{creating?`New proposal · ${title||'Untitled'}`:destination?proposalLabel(doc,destination):target?`${target} · Unavailable`:'Choose a Draft when saving'}</p><button type="button" className="secondary" disabled={busy||uncertain} onClick={()=>{setIntent('save');setPicker(true);}}>Choose destination</button></div>
        {error&&<p role="alert" className="error-box">{error}</p>}
        {uncertain&&<button type="button" className="primary" disabled={busy} onClick={()=>void save(pending.current!.intent,true)}>Retry original save</button>}
        <div className="editor-actions">{draft.id&&<button type="button" className="delete-button" disabled={busy||uncertain} onClick={()=>begin('delete')}>Stage deletion</button>}<button type="button" className="ghost" disabled={busy} onClick={()=>navigate(onClose)}>Cancel</button><button className="primary" disabled={busy||uncertain||!!target&&blocked}>{busy?'Saving…':'Save to proposal'}</button></div>
      </form>
    </SheetContent></Sheet>
    <Dialog open={picker} onOpenChange={open=>{if(!open)cancelPicker();}}><DialogContent className="destination-dialog"><DialogTitle>Save to a change proposal</DialogTitle><DialogDescription>Select an open Draft or create a new proposal. Accepted requirements change only after reviewed Apply.</DialogDescription><form className="editor-form" onSubmit={e=>{e.preventDefault();if(intent==='delete')setConfirmDelete(true);else void save('save');}}>
      <label>Destination proposal<select aria-label="Destination proposal" value={target} disabled={busy||uncertain} onChange={e=>choose(e.target.value)}><option value="">Select an open proposal</option><option value="new">Create a new proposal</option>{(doc.proposals??[]).filter(p=>['Draft','Proposed'].includes(p.status)||p.id===target).map(p=><option key={p.id} value={p.id} disabled={p.status!=='Draft'}>{proposalLabel(doc,p)}</option>)}{target&&!creating&&!destination&&<option value={target} disabled>{target} · Unavailable</option>}</select></label>
      {creating&&<><label>Proposal title<input required minLength={3} maxLength={120} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>Reason for this change<textarea rows={3} maxLength={3000} value={description} onChange={e=>setDescription(e.target.value)}/></label><p className="field-hint">Starts from the latest accepted set. Creation and staging are one save.</p></>}
      {comparison}{error&&<p role="alert" className="error-box">{error}</p>}{uncertain&&<button type="button" className="primary" disabled={busy} onClick={()=>void save(pending.current!.intent,true)}>Retry original save</button>}
      <div className="editor-actions"><button type="button" className="ghost" disabled={busy} onClick={cancelPicker}>Cancel destination selection</button><button className="primary" disabled={blocked}>{intent==='delete'?'Continue to deletion':creating?'Create proposal and stage':'Stage in proposal'}</button></div>
    </form></DialogContent></Dialog>
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}><DialogContent><DialogTitle>Stage deletion of {draft.id}?</DialogTitle><DialogDescription>Remove {draft.id} · {draft.title} from {creating?'new proposal '+title:destination?.id+' · '+destination?.title}. Accepted requirements and frozen snapshots stay unchanged. Remove dependent links in the proposed set first.</DialogDescription>{comparison}{error&&<p className="error-box" role="alert">{error}</p>}<div className="editor-actions"><button className="ghost" onClick={()=>setConfirmDelete(false)}>Cancel</button><button className="primary" disabled={blocked} onClick={()=>void save('delete')}>Confirm staged deletion</button></div></DialogContent></Dialog>
    <Dialog open={switching} onOpenChange={open=>{setSwitching(open);if(!open)navigation.current=null;}}><DialogContent><DialogTitle>Keep your pending requirement?</DialogTitle><DialogDescription>Save it to a proposal, discard the pending input, or cancel and continue editing.</DialogDescription><div className="editor-actions"><button className="ghost" onClick={()=>{navigation.current=null;setSwitching(false);}}>Cancel</button><button className="secondary" disabled={busy} onClick={()=>{const next=navigation.current;navigation.current=null;setSwitching(false);next?.();}}>Discard</button><button className="primary" disabled={busy||uncertain} onClick={()=>{navigationSave.current=true;setSwitching(false);begin('save');}}>Save to a proposal</button></div></DialogContent></Dialog>
  </>;
});
