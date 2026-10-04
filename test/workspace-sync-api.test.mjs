import {acceptRequirements} from './fixtures/accepted-requirements.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error('Use a loopback database only.');
test('conditional workspace reads cover every committed version without changing data; stale writes expose reconciliation version',async()=>{
  async function write(body,status=200){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;}
  let doc=await write({action:'project',name:'CP-006 conditional reads QA (local)',prefix:'LQ'});
  const accept=async({requirements})=>doc=await acceptRequirements(doc,requirements,write);
  const read=since=>fetch(origin+'/api/workspace?'+new URLSearchParams({project:doc.id,since:String(since)}));
  const mutate=async(action,data={})=>doc=await write({action,project:doc.id,version:doc.version,...data});
  const unchanged=async()=>{const r=await read(doc.version);assert.equal(r.status,304);assert.equal(await r.text(),'');assert.equal(r.headers.get('cache-control'),'no-store');};
  await unchanged();await mutate('section',{section:{title:'Live checks',description:''}});
  await accept({requirements:[{section:doc.sections[0].id,title:'Original behavior',description:'Observe synchronized versioned changes.',criteria:['Changes become visible.'],priority:'High',status:'Draft'}]});
  await mutate('baseline',{name:'Frozen initial version'});const frozen=structuredClone(doc.baselines);
  const accepted=structuredClone(doc.requirements),setVersion=doc.requirementsVersion,old=doc.version;
  await mutate('proposal',{proposal:{title:'Proposal only change'}});assert.equal(doc.requirementsVersion,setVersion);
  const changed=await read(old);assert.equal(changed.status,200);assert.deepEqual(await changed.json(),doc);await unchanged();
  await mutate('proposal_requirement',{id:doc.proposals[0].id,requirement:{...doc.requirements[0],title:'Proposed behavior'}});await mutate('proposal_submit',{id:doc.proposals[0].id});assert.deepEqual(doc.requirements,accepted);
  const stale=await write({action:'delete',project:doc.id,version:old,id:doc.requirements[0].id},409);assert.equal(stale.current_workspace_version,doc.version);assert.match(stale.error,/reconcile/);await unchanged();
  const before=structuredClone(doc);await write({action:'requirements',project:doc.id,version:doc.version,requirements:[{}]},400);await unchanged();assert.deepEqual(await (await fetch(origin+'/api/workspace?project='+doc.id)).json(),before);
  await mutate('proposal_review',{id:doc.proposals[0].id,review:{decision:'apply'}});const applied=await (await read(old)).json();assert.equal(applied.requirements[0].title,'Proposed behavior');assert.equal(applied.proposals[0].appliedSnapshot,applied.baselines[0].id);assert.deepEqual(applied.baselines.slice(1),frozen);
  for(const invalid of ['-1','1.5','NaN','9007199254740992'])assert.equal((await read(invalid)).status,400);
  assert.equal((await fetch(origin+'/api/workspace?since=1')).status,400);assert.equal((await fetch(origin+'/api/workspace?project=absent&since=1')).status,404);
  for(let i=0;i<3;i++)await unchanged();assert.deepEqual(await (await fetch(origin+'/api/workspace?project='+doc.id)).json(),doc);
});
