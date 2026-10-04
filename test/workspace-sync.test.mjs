import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSync,retryDelay,newerWorkspace} from '../lib/workspace-sync.ts';
const doc=(version,id='a')=>({id,version,requirementsVersion:1,requirements:[],proposals:[],history:[]});
const response=value=>Response.json(value);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(fetch,extra={}){const documents=[],states=[];const sync=new WorkspaceSync('a',{fetch,onDocument:(d)=>documents.push(d),onState:s=>states.push(s),...extra});return {sync,documents,states};}

test('monotonic committed versions include proposal-only changes and reject duplicate/old/other-project results',async()=>{
  const {sync,documents}=setup(async()=>response(doc(1)));
  try{await sync.refresh();assert.equal(sync.accept(doc(3)),true);assert.equal(sync.accept(doc(2)),false);assert.equal(sync.accept(doc(3)),false);assert.equal(sync.accept(doc(4,'b')),false);assert.deepEqual(documents.map(d=>d.version),[1,3]);assert.equal(newerWorkspace('a',doc(3),doc(2)),false);}finally{sync.stop();}
});
test('a newer save wins over an older in-flight read and a version gap reconciles the complete document',async()=>{
  const pending=deferred();const {sync,documents}=setup(()=>pending.promise);
  try{const read=sync.refresh();sync.accept(doc(8));pending.resolve(response(doc(4)));await read;assert.equal(sync.current.version,8);assert.equal(documents.length,1);sync.accept({...doc(20),proposals:[{id:'CP-001',status:'Applied'}]});assert.equal(sync.current.proposals[0].status,'Applied');}finally{sync.stop();}
});
test('overlapping refresh requests coalesce into one follow-up and unchanged checks do not replace data',async()=>{
  const pending=deferred();let calls=0;const urls=[];
  const {sync,documents}=setup(async url=>{urls.push(url);calls++;return calls===1?pending.promise:new Response(null,{status:304});});
  try{const first=sync.refresh();sync.refresh();sync.refresh();sync.refresh();pending.resolve(response(doc(2)));await first;await new Promise(r=>setTimeout(r,0));assert.equal(calls,2);assert.equal(documents.length,1);assert.match(urls[1],/project=a&since=2/);}finally{sync.stop();}
});
test('cleanup ignores a late result even when a transport ignores cancellation',async()=>{
  const pending=deferred();const {sync,documents,states}=setup(()=>pending.promise);
  const first=sync.refresh();sync.stop();const count=states.length;pending.resolve(response(doc(9)));await first;assert.equal(documents.length,0);assert.equal(states.length,count);assert.equal(sync.accept(doc(11)),false);
});
test('transient failures and offline retain last success, resume automatically, and never mutate',async()=>{
  let online=true,fail=false,version=1,calls=0;
  const {sync,states}=setup(async()=>{calls++;if(fail)return new Response('',{status:503});return response(doc(version));},{online:()=>online,now:()=>123});
  try{await sync.refresh();fail=true;await sync.refresh();assert.equal(states.at(-1).phase,'reconnecting');assert.equal(states.at(-1).lastSuccess,123);online=false;const before=calls;await sync.refresh();assert.equal(calls,before);assert.equal(states.at(-1).phase,'offline');assert.equal(sync.current.version,1);fail=false;online=true;version=5;await sync.refresh();assert.equal(sync.current.version,5);assert.equal(states.at(-1).phase,'current');}finally{sync.stop();}
});
test('hidden tabs skip checks; wakeup catches every missed commit',async()=>{
  let visible=false,calls=0;const {sync}=setup(async()=>{calls++;return response(doc(21));},{visible:()=>visible});
  try{await sync.refresh();assert.equal(calls,0);visible=true;await sync.refresh();assert.equal(sync.current.version,21);}finally{sync.stop();}
});
test('expired/denied access and login HTML block delivery until explicit authorized recovery',async()=>{
  for(const failure of [new Response('',{status:401}),new Response('',{status:403}),new Response('',{status:302}),{status:0,type:'opaqueredirect'},new Response('<html>Sign in</html>',{headers:{'Content-Type':'text/html'}})]){
    let allowed=false;const {sync,states}=setup(async()=>allowed?response(doc(3)):failure);
    try{sync.accept(doc(1));await sync.refresh();assert.equal(states.at(-1).phase,'blocked');assert.equal(sync.current.version,1);allowed=true;await sync.refresh();assert.equal(sync.current.version,3);assert.equal(states.at(-1).phase,'current');}finally{sync.stop();}
  }
});
test('backoff is jittered and bounded to thirty seconds',()=>{
  for(let n=1;n<100;n++){assert.ok(retryDelay(n,()=>0)>0);assert.ok(retryDelay(n,()=>1)<=30000);}
  assert.notEqual(retryDelay(1,()=>0),retryDelay(1,()=>1));
});
test('access denial cancels an earlier read and cannot be undone by its late response',async()=>{
  const pending=deferred();const {sync,states}=setup(()=>pending.promise);
  try{sync.accept(doc(1));const read=sync.refresh();sync.deny();pending.resolve(response(doc(9)));await read;assert.equal(sync.current.version,1);assert.equal(states.at(-1).phase,'blocked');assert.equal(sync.accept(doc(10)),false);}finally{sync.stop();}
});
