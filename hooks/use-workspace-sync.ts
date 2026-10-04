'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {Workspace} from '@/lib/types';
import {WorkspaceSync,type SyncState} from '@/lib/workspace-sync';

export function useWorkspaceSync(project:string){
  const [doc,setDoc]=useState<Workspace|null>(null);
  const [state,setState]=useState<SyncState>({phase:'connecting',lastSuccess:null,message:''});
  const [announcement,setAnnouncement]=useState('');
  const current=useRef<Workspace|null>(null),loop=useRef<WorkspaceSync|null>(null);
  useEffect(()=>{
    current.current=null;setDoc(null);setAnnouncement('');setState({phase:'connecting',lastSuccess:null,message:''});
    const sync=new WorkspaceSync(project,{fetch:(...args)=>fetch(...args),online:()=>navigator.onLine,visible:()=>document.visibilityState!=='hidden',onState:setState,onDocument:(next,remote)=>{
      const prior=current.current;current.current=next;setDoc(next);
      if(remote&&prior)setAnnouncement('Saved workspace changes received. Open edits are preserved.');
    }});
    loop.current=sync;void sync.refresh();
    const wake=()=>void sync.refresh();
    window.addEventListener('online',wake);window.addEventListener('offline',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
    return()=>{sync.stop();window.removeEventListener('online',wake);window.removeEventListener('offline',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
  },[project]);
  const refresh=useCallback(async()=>{await loop.current?.refresh();return current.current;},[]);
  const accept=useCallback((next:Workspace)=>loop.current?.accept(next),[]);
  const deny=useCallback((message?:string)=>loop.current?.deny(message),[]);
  return {doc:doc?.id===project?doc:null,current,state,announcement,refresh,accept,deny};
}
