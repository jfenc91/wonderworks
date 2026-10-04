'use client';
import {useState} from 'react';
import type {Workspace} from '@/lib/types';

// Opening and explicit reconciliation are the only operations that advance an
// edit's save token. Background read-model changes never do.
export function useEditBase(initial?:Workspace){
  const [base,setBase]=useState<Workspace|null>(initial??null);
  return {base,setBase};
}
export function EditConflict({base,doc,onReconcile,latest,invalid}:{base:Workspace|null;doc:Workspace;onReconcile:()=>void;latest:unknown;invalid?:string}){
  if(!base||base.id===doc.id&&base.version===doc.version&&!invalid)return null;
  return <section className="edit-conflict" role="status">
    <strong>{invalid||'Newer saved workspace available'}</strong>
    <p>Your input is preserved. This edit began at workspace revision {base.version}; the saved workspace is now revision {doc.version}. Inspect the saved content and adjust your input before continuing.</p>
    <details><summary>Inspect latest saved content</summary><pre>{JSON.stringify(latest??'Target no longer exists',null,2)}</pre></details>
    {invalid?<p>Copy any input you want to keep, then cancel this edit. This action cannot be reconciled here.</p>:<button className="secondary" type="button" onClick={onReconcile}>I reviewed latest; keep my input</button>}
  </section>;
}
export function editBlocked(base:Workspace|null,doc:Workspace,invalid?:string){return !base||base.id!==doc.id||base.version!==doc.version||!!invalid;}
