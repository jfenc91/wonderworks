import type {Workspace} from './types';

export const CHECK_INTERVAL = 1500;
export const MAX_RETRY_INTERVAL = 30000;
// Both initial loads and changed-version polls can return the complete project,
// including its retained history. Give those downloads a bounded, realistic
// deadline without slowing the cadence of successful unchanged checks.
export const WORKSPACE_READ_TIMEOUT = 30000;
export type SyncState = {phase:'connecting'|'current'|'reconnecting'|'offline'|'blocked';lastSuccess:number|null;message:string};
export class AccessRequired extends Error {}
export function retryDelay(failures:number,random=Math.random){
  return Math.min(MAX_RETRY_INTERVAL,1500*2**Math.min(failures,5)*(0.75+random()*0.5));
}
export function newerWorkspace(project:string,current:Workspace|null,incoming:Workspace){
  return incoming.id===project&&(!current||current.id!==project||incoming.version>current.version);
}

// One owner per mounted project. All notifications, manual refreshes and wakeups
// share this bounded loop; reads and save responses share the same version gate.
export class WorkspaceSync {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private request:Promise<void>|null=null;
  private abort:AbortController|null=null;
  private stopped=false;
  private queued=false;
  private failures=0;
  private blocked=false;
  private lastSuccess:number|null=null;
  private doc:Workspace|null=null;
  constructor(readonly project:string,private options:{
    fetch:typeof fetch;onDocument:(doc:Workspace,remote:boolean)=>void;onState:(state:SyncState)=>void;
    online?:()=>boolean;visible?:()=>boolean;random?:()=>number;now?:()=>number;
  }){}
  get current(){return this.doc;}
  private state(phase:SyncState['phase'],message=''){
    if(!this.stopped)this.options.onState({phase,lastSuccess:this.lastSuccess,message});
  }
  accept(doc:Workspace,remote=false){
    if(this.stopped||this.blocked||!newerWorkspace(this.project,this.doc,doc))return false;
    this.doc=doc;this.options.onDocument(doc,remote);return true;
  }
  deny(message='Sign in or restore access, then retry synchronization.'){
    this.blocked=true;this.queued=false;this.abort?.abort();clearTimeout(this.timer);this.state('blocked',message);
  }
  refresh=():Promise<void>=>{
    if(this.stopped)return Promise.resolve();
    clearTimeout(this.timer);
    if(this.request){this.queued=true;return this.request;}
    this.blocked=false;
    this.request=this.check().finally(()=>{
      this.request=null;
      if(this.stopped)return;
      if(this.queued){this.queued=false;void this.refresh();}
      else if(!this.blocked)this.timer=setTimeout(()=>void this.refresh(),this.failures?retryDelay(this.failures,this.options.random):CHECK_INTERVAL);
    });
    return this.request;
  };
  private async check(){
    if(this.options.online?.()===false){this.failures++;this.state('offline','Offline. Displayed data may be stale.');return;}
    if(this.options.visible?.()===false)return;
    const abort=new AbortController();this.abort=abort;
    const timeout=setTimeout(()=>abort.abort(),WORKSPACE_READ_TIMEOUT);
    if(!this.doc)this.state('connecting');
    try{
      const query=new URLSearchParams({project:this.project,...(this.doc?{since:String(this.doc.version)}:{})});
      const response=await this.options.fetch('/api/workspace?'+query,{cache:'no-store',redirect:'manual',signal:abort.signal});
      if(this.stopped||this.blocked)return;
      if(abort.signal.aborted)throw Error('Connection timed out. Displayed data may be stale.');
      if([401,403,404].includes(response.status)||response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400&&response.status!==304)throw new AccessRequired(response.status===404?'This project is unavailable. Choose another project or restore access.':'Sign in or restore access, then retry synchronization.');
      if(response.status!==304){
        if(!response.ok)throw Error('Unable to check for changes. Displayed data may be stale.');
        if(!response.headers.get('content-type')?.includes('application/json'))throw new AccessRequired('Sign in or restore access, then retry synchronization.');
        const doc=await response.json() as Workspace;
        if(this.stopped||this.blocked)return;
        if(abort.signal.aborted)throw Error('Connection timed out. Displayed data may be stale.');
        if(doc.id!==this.project||!Number.isSafeInteger(doc.version))throw Error('Unable to reconcile this project. Retry synchronization.');
        this.accept(doc,true);
      }
      this.failures=0;this.lastSuccess=(this.options.now??Date.now)();this.state('current');
    }catch(error){
      if(this.stopped||this.blocked)return;
      if(error instanceof AccessRequired){this.deny(error.message);return;}
      this.failures++;this.state('reconnecting',error instanceof Error&&!abort.signal.aborted?error.message:'Connection timed out. Displayed data may be stale.');
    }finally{clearTimeout(timeout);}
  }
  stop(){this.stopped=true;clearTimeout(this.timer);this.abort?.abort();}
}
