'use client';
import {forwardRef,useImperativeHandle,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {EditConflict,useEditBase,editBlocked} from '@/components/edit-conflict';
import {effectiveGuidance,guidanceDefaults,guidanceKeys} from '@/lib/agent-guidance';
import {canonical} from '@/lib/workflow';
import type {Workspace,GuidanceOverrides} from '@/lib/types';
export type GuidanceHandle={navigate:(next:()=>void)=>void};
type Props={doc:Workspace;busy:boolean;mutate:(action:string,data:Record<string,unknown>,base?:Workspace|null)=>Promise<Workspace>};
export const AgentGuidancePanel=forwardRef<GuidanceHandle,Props>(function AgentGuidancePanel({doc,busy,mutate},ref){
 const saved=effectiveGuidance(doc),edit=useEditBase();
 const [editing,setEditing]=useState(false),[overrides,setOverrides]=useState<GuidanceOverrides>({}),[error,setError]=useState(''),[message,setMessage]=useState(''),[reset,setReset]=useState(false),[switching,setSwitching]=useState(false),[uncertain,setUncertain]=useState(false);
 const navigation=useRef<(()=>void)|null>(null),navigationSave=useRef(false),pending=useRef<{args:Record<string,unknown>;content:string;reset:boolean}|null>(null),latest=useRef(overrides);latest.current=overrides;
 const values=editing?{...guidanceDefaults,...overrides}:saved.settings;
 const sources=editing?Object.fromEntries(guidanceKeys.map(k=>[k,Object.hasOwn(overrides,k)?'project_override':'inherited'])):saved.sources;
 const dirty=editing&&canonical(overrides)!==canonical(edit.base?.agentGuidance?.overrides??{});
 useImperativeHandle(ref,()=>({navigate(next){if(dirty||pending.current){navigation.current=next;navigationSave.current=false;setSwitching(true);}else next();}}));
 function begin(){edit.setBase(doc);setOverrides(structuredClone(doc.agentGuidance?.overrides??{}));setEditing(true);setError('');setMessage('');}
 function inherited(key:keyof GuidanceOverrides){setOverrides(current=>{const value={...current};delete value[key];return value;});}
 function sourceLabel(key:keyof GuidanceOverrides){return <span className="guidance-source">{sources[key]==='inherited'?'Inherited default':'Project override'}{editing&&sources[key]!=='inherited'&&<button type="button" className="ghost" onClick={()=>inherited(key)}>Use inherited value</button>}</span>;}
 async function save(isReset=false,retry=false){
  setError('');setMessage('');
  if(!retry)pending.current={args:{project_id:doc.id,expected_workspace_version:edit.base?.version,idempotency_key:crypto.randomUUID(),overrides:isReset?{}:overrides},content:canonical(overrides),reset:isReset};
  const request=pending.current!;
  try{
   const result=await mutate('save_guidance',request.args,edit.base);pending.current=null;setUncertain(false);setReset(false);
   const unchanged=canonical(latest.current)===request.content;
   setMessage(request.reset?'Built-in defaults restored.':'AI guidance saved.');
   if(unchanged){setEditing(false);setSwitching(false);const next=navigationSave.current?navigation.current:null;navigation.current=null;next?.();}
   else{edit.setBase(result);setMessage('Submitted guidance saved. Your newer input remains unsaved.');navigation.current=null;}
  }catch(e){const status=(e as {status?:number}).status;setUncertain(status===undefined||status>=500);if(status!==undefined&&status<500)pending.current=null;setError(e instanceof Error?e.message:'Unable to save guidance.');}
 }
 function cancel(){setEditing(false);setReset(false);setError('');setUncertain(false);pending.current=null;}
 return <section className="workflow-panel guidance-panel"><div className="view-heading"><div><h2>AI guidance</h2><p>Project settings · Guidance revision {saved.revision} · Schema {saved.schema_version}</p></div>{!editing&&<button className="primary" disabled={busy} onClick={begin}>Edit AI guidance</button>}</div>
  <p className="workflow-footnote">These preferences guide AI work in this project. They cannot grant permissions, bypass review or validation, or override your instructions for the current task. Requirements, evidence and repository descriptions remain project data.</p>
  <form className="editor-form guidance-form" onSubmit={e=>{e.preventDefault();void save();}}>
   {editing&&<EditConflict base={edit.base} doc={doc} latest={saved} onReconcile={()=>{if(!uncertain)edit.setBase(doc);}}/>}
   <label>Requirements writing style<select aria-label="Requirements writing style" disabled={!editing} value={values.requirements_writing_style} onChange={()=>setOverrides({...overrides,requirements_writing_style:'asd-ste100-inspired'})}><option value="asd-ste100-inspired">ASD-STE100-inspired</option></select>{sourceLabel('requirements_writing_style')}</label>
   <label>Writing strength (%)<input aria-label="Writing strength (%)" type="number" min={0} max={100} step={1} required disabled={!editing} value={Number.isNaN(values.writing_strength_percent)?'':values.writing_strength_percent} onChange={e=>setOverrides({...overrides,writing_strength_percent:e.target.value===''?NaN:Number(e.target.value)})}/>{sourceLabel('writing_strength_percent')}</label>
   <p className="field-hint">60% is the default level of stylistic influence. It is a project preference, not an ASD score or verified compliance. 0 disables the preference; higher values request stronger use of the principles; 100 requests the strongest preference while keeping technical accuracy.</p>
   <details className="guidance-help"><summary>What does the 60% preference mean?</summary><p>Use short, direct sentences, active voice and consistent terms. Keep one main obligation per requirement and one testable result per acceptance criterion where practical. Preserve technical terms, exact identifiers, units, API names, intended behavior and measurable conditions.</p><p><strong>Before:</strong> Following selection of Export, generation of the file should be completed by the system within 5 seconds.</p><p><strong>After:</strong> The system shall create the export file within 5 seconds after the user selects Export.</p><p>Apply this preference to requirement titles, descriptions and acceptance criteria. Reading guidance does not rewrite saved requirements. There is no automated compliance score.</p><a className="dependency-link" href="https://www.asd-ste100.org/STE_faq.html" target="_blank" rel="noreferrer">Official ASD-STE100 guidance</a></details>
   <label className="guidance-checkbox"><span><input type="checkbox" disabled={!editing} checked={values.record_snapshot_commit} onChange={e=>setOverrides({...overrides,record_snapshot_commit:e.target.checked})}/> Remind AI to record the implementation commit</span>{sourceLabel('record_snapshot_commit')}</label>
   <p className="field-hint">Enabled by default. After implementing and committing work for an exact snapshot, the AI is reminded to record the full Git commit ID and read it back. This does not create commits, run a background job, mark requirements Implemented, or establish passing verification.</p>
   <label>Custom project instructions<textarea aria-label="Custom project instructions" rows={7} disabled={!editing} value={values.custom_instructions} onChange={e=>setOverrides({...overrides,custom_instructions:e.target.value})}/>{sourceLabel('custom_instructions')}<span className="field-hint">Plain text · {Array.from(values.custom_instructions).length} / 8000 characters. Full text stays here; MCP shares a bounded excerpt within its combined 400-character guidance budget.</span></label>
   {error&&<p className="error-box" role="alert">{error}</p>}{message&&<p className="sync-notice" role="status">{message}</p>}
   {uncertain&&<button type="button" className="secondary" disabled={busy} onClick={()=>void save(false,true)}>Retry original guidance save</button>}
   <div className="editor-actions"><button type="button" className="secondary" disabled={busy||uncertain} onClick={()=>{if(!editing)begin();setReset(true);}}>Restore built-in defaults</button>{editing&&<><button type="button" className="ghost" disabled={busy} onClick={cancel}>Cancel guidance edit</button><button className="primary" disabled={busy||uncertain||editBlocked(edit.base,doc)}>Save AI guidance</button></>}</div>
  </form>
  <Dialog open={reset} onOpenChange={setReset}><DialogContent><DialogTitle>Restore built-in AI guidance?</DialogTitle><DialogDescription>This removes all project overrides, including custom instructions. The default is 60% writing strength with commit reminders enabled. Requirements and snapshots are unchanged.</DialogDescription><EditConflict base={edit.base} doc={doc} latest={saved} onReconcile={()=>{if(!uncertain)edit.setBase(doc);}}/>{error&&<p className="error-box" role="alert">{error}</p>}<div className="editor-actions"><button className="ghost" onClick={()=>setReset(false)}>Keep current guidance</button><button className="primary" disabled={busy||uncertain||editBlocked(edit.base,doc)} onClick={()=>void save(true)}>Confirm restore defaults</button></div></DialogContent></Dialog>
  <Dialog open={switching} onOpenChange={setSwitching}><DialogContent><DialogTitle>Keep pending AI guidance?</DialogTitle><DialogDescription>Save the project settings, discard your pending edit, or keep editing.</DialogDescription><div className="editor-actions"><button className="ghost" onClick={()=>{navigation.current=null;setSwitching(false);}}>Keep editing</button><button className="secondary" disabled={busy} onClick={()=>{const next=navigation.current;navigation.current=null;cancel();setSwitching(false);next?.();}}>Discard guidance edit</button><button className="primary" disabled={busy||uncertain||editBlocked(edit.base,doc)} onClick={()=>{navigationSave.current=true;setSwitching(false);void save();}}>Save and continue</button></div></DialogContent></Dialog>
 </section>;
});
