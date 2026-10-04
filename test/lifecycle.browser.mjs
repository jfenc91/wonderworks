import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {acceptRequirements} from './fixtures/accepted-requirements.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_ROOT??'playwright');
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
const mcpOrigin=process.env.WONDERWORKS_MCP_URL??origin;
if(!['localhost','127.0.0.1'].includes(new URL(mcpOrigin).hostname))throw Error('Use loopback MCP QA storage.');
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Use loopback QA storage.');
async function rest(body,status=200,path='/api/workspace'){const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;}
test('automatic lifecycle agrees across two browsers, a separate MCP client, frozen views and guarded pending edits',async t=>{
 let doc=await rest({action:'project',name:'BL010 lifecycle browser '+Date.now(),prefix:'LB'});
 const read=async()=>doc=await(await fetch(origin+'/api/workspace?project='+doc.id)).json();
 const write=async(action,data={})=>{await read();return doc=await rest({project:doc.id,version:doc.version,action,...data});};
 await write('section',{section:{title:'Lifecycle behavior',description:''}});
 const req=(title,extra={})=>({section:doc.sections[0].id,title,description:'The accepted revision has an exact implementation context.',criteria:['The lifecycle is observed.'],...extra});
 doc=await acceptRequirements(doc,[req('First accepted behavior'),req('Unchanged carried behavior'),req('Editorial overview',{kind:'information',criteria:[],status:'Draft'})],rest);
 const baseline=doc.baselines[0].id;await write('evidence',{evidence:{baseline,artifactUrl:'https://example.com/executed-failure',summary:'A deliberately failed local fixture check.',checks:[{id:'LB-001',title:'Recorded failure',passed:false,detail:'A commit must not turn this result into a pass.'}]}});
 await write('proposal',{proposal:{title:'Pending authored revision'}});const proposal=doc.proposals[0].id;
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})}),aContext=await browser.newContext({viewport:{width:1500,height:1100}}),bContext=await browser.newContext({viewport:{width:1500,height:1100}}),a=await aContext.newPage(),b=await bContext.newPage(),errors=[],measurements=[];
 for(const page of [a,b]){page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));}
 const select=async page=>{await page.goto(origin);await page.getByRole('combobox',{name:'Current project',exact:true}).click();await page.getByRole('option',{name:doc.name,exact:true}).click();};
 const reflected=async(page,version=doc.version)=>{const start=Date.now();await page.getByText(`Workspace revision ${version} · Durable storage`,{exact:true}).waitFor({state:'attached',timeout:5000});return Date.now()-start;};
 const cookie=(await fetch(mcpOrigin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
 const mcp=async(name,args,code)=>{const r=await fetch(mcpOrigin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',Cookie:cookie},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});const v=(await r.json()).result;assert.equal(v.isError,!!code,JSON.stringify(v));if(code)assert.equal(v.structuredContent.error.code,code);return v.structuredContent;};
 const commit=async(value,baseline_id=baseline)=>{await read();const result=await mcp('set_snapshot_implementation',{project_id:doc.id,baseline_id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),implementation_commit:value?{commit_id:value}:null});await read();return result;};
 try{
  await Promise.all([select(a),select(b)]);await Promise.all([reflected(a),reflected(b)]);
  await t.test('accepted cards/readiness are approved; editor is read-only and remote lifecycle retains dirty input/focus',async()=>{
   await a.locator('.requirement-select').first().dblclick();await a.getByLabel('Title',{exact:true}).fill('Pending first revision');await a.getByLabel('Title',{exact:true}).focus();assert.equal(await a.getByRole('combobox',{name:'Status',exact:true}).count(),0);await a.getByLabel('Requirement lifecycle status').filter({hasText:'Approved on Apply'}).waitFor();
   const before=structuredClone(doc),result=await commit('a'.repeat(40));assert.equal(result.affected_requirements.length,2);measurements.push(await reflected(a));measurements.push(await reflected(b));assert.equal(doc.requirementsVersion,before.requirementsVersion);assert.deepEqual(doc.baselines,before.baselines);assert.equal(doc.requirements[2].status,'Draft');
   assert.equal(await a.getByLabel('Title',{exact:true}).inputValue(),'Pending first revision');assert.ok(await a.getByLabel('Title',{exact:true}).evaluate(el=>el===document.activeElement));await a.getByRole('button',{name:'I reviewed latest; keep my input',exact:true}).waitFor();
   await b.locator('.requirement-select').first().click();await b.locator('.lifecycle-support').getByText(/Current accepted lifecycle · r1 · Implemented/).waitFor();await b.locator('.lifecycle-support').getByText('a'.repeat(40),{exact:true}).waitFor();assert.match(await b.locator('.project-summary').innerText(),/100%/);
   const p=(await mcp('get_proposal',{project_id:doc.id,proposal_id:proposal})).proposal;assert.equal(p.stale,false);assert.equal(p.changes.length,0);assert.equal(p.requirements[0].status,'Implemented');
   await a.getByRole('button',{name:'Save to proposal',exact:true}).click();await a.getByLabel('Destination proposal',{exact:true}).selectOption(proposal);assert.ok(await a.getByRole('button',{name:'Stage in proposal',exact:true}).isDisabled());await a.getByRole('button',{name:'I reviewed latest; keep my input',exact:true}).click();
   const pending=a.waitForResponse(r=>r.url().endsWith('/api/proposal-authoring')&&r.request().method()==='POST');await a.getByRole('button',{name:'Stage in proposal',exact:true}).click();assert.equal((await pending).status(),200);await read();await reflected(a);await a.locator('.inspector').getByText('Pending → Approved on Apply',{exact:true}).waitFor();assert.equal(doc.requirements[0].status,'Implemented');
  });
  await t.test('review Apply approves changed revision while preserving unchanged implementation; history records every acceptance',async()=>{
   await write('proposal_submit',{id:proposal});await reflected(b);await b.getByRole('tab',{name:/Changes/}).click();await b.locator('.proposal-list-item').filter({hasText:'Pending authored revision'}).click();await b.getByRole('button',{name:'Apply 1 change',exact:true}).click();const pending=b.waitForResponse(r=>r.url().endsWith('/api/workspace')&&r.request().method()==='POST');await b.getByRole('button',{name:'Apply and snapshot',exact:true}).click();assert.equal((await pending).status(),200);await read();measurements.push(await reflected(a));assert.equal(doc.requirements[0].status,'Approved');assert.equal(doc.requirements[0].revision,2);assert.equal(doc.requirements[1].status,'Implemented');assert.equal(doc.baselines[0].requirements[0].status,'Approved');
   const h=await mcp('get_requirement_history',{project_id:doc.id,requirement_id:'LB-001'});assert.equal(h.lifecycle.last_approved.revision,2);assert.equal(h.lifecycle.last_implemented.revision,1);
   await a.getByRole('button',{name:'Return to latest accepted requirements',exact:true}).click();await a.locator('.requirement-select').first().click();await a.getByRole('button',{name:'History of LB-001',exact:true}).first().click();await a.locator('.requirement-history-reader').getByText(/Approval recorded for r2/).waitFor();await a.keyboard.press('Escape');
  });
  await t.test('older commits skip newer revisions; multiple supports and clears preserve failures and exact frozen labels',async()=>{
   const frozen=structuredClone(doc.baselines),currentBaseline=doc.baselines[0].id;
   await commit('b'.repeat(40));assert.equal(doc.requirements[0].status,'Approved');const result=await commit('c'.repeat(40),currentBaseline);assert.equal(result.affected_requirements.length,2);assert.equal(doc.requirements[0].status,'Implemented');assert.equal(doc.evidence[0].checks[0].passed,false);measurements.push(await reflected(a));
   await a.getByRole('tab',{name:/Snapshots/}).click();await a.getByRole('button',{name:'View snapshot'}).first().click();await a.getByText('Current lifecycle compared with this frozen snapshot',{exact:true}).click();await a.getByText(/LB-001 · Frozen r2: Approved · Current r2: Implemented/).waitFor();await a.screenshot({path:'outputs/bl010-snapshot.png',fullPage:true});await a.keyboard.press('Escape');
   await commit(null,currentBaseline);assert.equal(doc.requirements[0].status,'Approved');assert.equal(doc.requirements[1].status,'Implemented');await commit(null,baseline);assert.equal(doc.requirements[1].status,'Approved');assert.deepEqual(doc.baselines,frozen);assert.equal(doc.evidence[0].checks[0].passed,false);
   await a.getByRole('tab',{name:'Traceability',exact:true}).click();await a.getByText('Not verified',{exact:true}).first().waitFor();await a.getByRole('tab',{name:'Verification',exact:true}).click();await a.getByText('Failed',{exact:true}).waitFor();
  });
  await t.test('explicit reconciliation has a reviewable preview, is durable and is a repeat no-op',async()=>{
   await reflected(b);await b.getByRole('tab',{name:'Settings',exact:true}).click();await b.getByRole('heading',{name:'Lifecycle reconciliation',exact:true}).waitFor();const pending=b.waitForResponse(r=>r.url().endsWith('/api/lifecycle-reconciliation'));await b.getByRole('button',{name:'Reconcile lifecycle from saved records',exact:true}).click();assert.equal((await pending).status(),200);await read();await reflected(b);await b.getByText(/Lifecycle reconciled. Unproven legacy statuses/).waitFor();assert.ok(await b.getByRole('button',{name:'Reconcile lifecycle from saved records',exact:true}).isDisabled());
   const before=structuredClone(doc);const retry=await rest({project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID()},200,'/api/lifecycle-reconciliation');assert.equal(retry.workspace_version,doc.version);assert.deepEqual(await read(),before);
   await b.setViewportSize({width:390,height:844});await b.screenshot({path:'outputs/bl010-compact.png',fullPage:true});
  });
  assert.deepEqual(errors,[]);console.log('BL010_LIVE_UPDATE_MS='+JSON.stringify(measurements));await writeFile('outputs/bl010-browser-result.json',JSON.stringify({project_id:doc.id,visible_update_ms:measurements},null,2));
 }finally{await browser.close();}
});
