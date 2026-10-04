import test from 'node:test';
import assert from 'node:assert/strict';
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error('Storage migration checks require a loopback server.');
test('storage maintenance preserves API workspace bytes and versions and rejects stale or malformed requests',async()=>{
 const json=async(path,body,status=200)=>{const r=await fetch(origin+path,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};
 const doc=await json('/api/workspace',{action:'project',name:'QA storage preservation '+Date.now(),prefix:'ST'});
 const url='/api/workspace?project='+encodeURIComponent(doc.id),before=await json(url);
 const result=await json('/api/storage-migration',{project_id:doc.id,expected_workspace_version:doc.version});assert.equal(result.status,'already_migrated');assert.deepEqual(await json(url),before);
 await json('/api/storage-migration',{project_id:doc.id,expected_workspace_version:doc.version+1},409);
 await json('/api/storage-migration',{project_id:doc.id,expected_workspace_version:-1},400);assert.deepEqual(await json(url),before);
 const forbidden=await fetch(origin+'/api/storage-migration',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://invalid.example'},body:JSON.stringify({project_id:doc.id,expected_workspace_version:doc.version})});assert.equal(forbidden.status,403);
});
