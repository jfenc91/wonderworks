import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_ROOT??'playwright');
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Use a loopback QA database only.');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function rest(body){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
async function until(check,timeout=5000){const start=Date.now();while(!await check()){if(Date.now()-start>timeout)throw Error('Condition timed out');await wait(50);}}

test('independent browser sessions, MCP, protected edits/reviews, recovery and unchanged checks',{timeout:180000},async t=>{
  let doc=await rest({action:'project',name:'CP-006 Live Browser QA '+Date.now(),prefix:'LB'});
  const read=async()=>doc=await (await fetch(origin+'/api/workspace?project='+doc.id)).json();
  const mutate=async(action,data={})=>{await read();return doc=await rest({project:doc.id,version:doc.version,action,...data});};
  await mutate('section',{section:{title:'Live collaboration',description:'Independent clients in a local database.'}});
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:1000}}),browser.newContext({viewport:{width:1440,height:1000}})]);
  const [a,b]=await Promise.all(contexts.map(c=>c.newPage()));const errors=[];a.on('pageerror',e=>errors.push(e.message));b.on('pageerror',e=>errors.push(e.message));
  const select=async(page,name)=>{await page.getByRole('combobox',{name:'Current project',exact:true}).click();await page.getByRole('option',{name,exact:true}).click();};
  const reflected=async(version,page=a)=>{const started=Date.now();await page.getByText(`Workspace revision ${version} · Durable storage`,{exact:true}).waitFor({timeout:5000});assert.ok(Date.now()-started<5000);return Date.now()-started;};
  const saveUI=async(page)=>{const saved=page.waitForResponse(r=>r.url().endsWith('/api/workspace')&&r.request().method()==='POST');await page.getByRole('button',{name:'Save requirement',exact:true}).click();const response=await saved;assert.equal(response.status(),200,await response.text());doc=await response.json();};
  const measurements=[];
  try{
    await Promise.all([a.goto(origin),b.goto(origin)]);await Promise.all([select(a,doc.name),select(b,doc.name)]);await reflected(doc.version);await reflected(doc.version,b);
    await t.test('browser create/edit/delete arrives under five seconds without navigation',async()=>{
      await b.getByRole('button',{name:'New requirement',exact:true}).click();await b.getByRole('textbox',{name:'Title',exact:true}).fill('Remote original');await b.getByRole('textbox',{name:'Description',exact:true}).fill('A behavior created in a separate browser.');await b.getByRole('textbox',{name:/Acceptance criteria/}).fill('Other sessions see this change.');await saveUI(b);measurements.push(await reflected(doc.version));
      await a.getByRole('heading',{name:'Remote original',exact:true}).waitFor();
      await b.locator('.requirement-select').first().dblclick();await b.getByRole('textbox',{name:'Title',exact:true}).fill('Remote revised');await saveUI(b);measurements.push(await reflected(doc.version));await a.getByRole('heading',{name:'Remote revised',exact:true}).waitFor();
    });
    const target=doc.requirements[0].id;
    await t.test('dirty edit retains all input/focus and requires explicit saved-base reconciliation',async()=>{
      await a.locator('.requirement-select').first().dblclick();const title=a.getByRole('textbox',{name:'Title',exact:true});await title.fill('My unsaved title');await title.focus();
      await mutate('section',{section:{title:'Unrelated new section',description:'Preserve pending input.'}});await reflected(doc.version);
      assert.equal(await title.inputValue(),'My unsaved title');assert.equal(await title.evaluate(el=>el===document.activeElement),true);assert.equal(await a.getByRole('button',{name:'Save requirement',exact:true}).isDisabled(),true);
      await a.getByRole('button',{name:'I reviewed latest; keep my input',exact:true}).click();await saveUI(a);assert.equal(doc.requirements[0].title,'My unsaved title');await reflected(doc.version,b);
      await a.locator('.requirement-select').first().dblclick();await title.fill('Keep this conflicting input');await mutate('requirements',{requirements:[{...doc.requirements[0],title:'Conflicting saved title'}]});await reflected(doc.version);assert.equal(await title.inputValue(),'Keep this conflicting input');
      await a.getByText('Inspect latest saved content',{exact:true}).click();await a.locator('.edit-conflict pre').filter({hasText:'Conflicting saved title'}).waitFor();
      await reflected(doc.version,b);await b.locator('.requirement-select').first().dblclick();await b.getByRole('button',{name:'Delete requirement',exact:true}).click();const deleted=b.waitForResponse(r=>r.url().endsWith('/api/workspace')&&r.request().method()==='POST');await b.getByRole('alertdialog').getByRole('button',{name:'Delete requirement',exact:true}).click();assert.equal((await deleted).status(),200);await read();await reflected(doc.version);await a.getByText('This requirement was deleted remotely.',{exact:true}).waitFor();assert.equal(await title.inputValue(),'Keep this conflicting input');assert.equal(await a.getByRole('button',{name:'Save requirement',exact:true}).isDisabled(),true);await a.getByRole('button',{name:'Cancel',exact:true}).click();await a.getByText(/selected requirement is no longer/).waitFor();
    });
    // A fresh current requirement for proposal and frozen-evidence checks.
    await mutate('requirements',{requirements:[{section:doc.sections[0].id,title:'Accepted behavior',description:'Retain the accepted set until explicit review.',criteria:['Proposal is separate.'],priority:'High',status:'Draft',tags:['live-updates']}]});await mutate('baseline',{name:'Browser frozen basis'});const frozen=structuredClone(doc.baselines[0]),accepted=structuredClone(doc.requirements);
    const login=await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'}),cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
    async function mcp(name,args){const r=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',Cookie:cookie},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const data=await r.json();assert.equal(data.result.isError,false,JSON.stringify(data));return data.result.structuredContent;}
    async function mcpWrite(name,args){await read();const result=await mcp(name,{project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),...args});await read();return result;}
    let proposal;
    await t.test('separate authenticated MCP client stages/submits; browser keeps accepted content separate',async()=>{
      await reflected(doc.version);await a.getByRole('tab',{name:/Changes/}).click();await mcpWrite('create_proposal',{title:'Live MCP proposal',description:'Independent client creates saved changes.'});proposal=doc.proposals[0].id;await reflected(doc.version);await a.getByRole('button',{name:/CP-001 · Live MCP proposal/}).click();
      await mcpWrite('stage_proposal_changes',{proposal_id:proposal,operations:[{op:'edit',requirement_id:accepted[0].id,requirement:{...Object.fromEntries(Object.entries(accepted[0]).filter(([k])=>!['id','revision'].includes(k))),title:'MCP proposed behavior'}},{op:'add',client_ref:'addition',requirement:{section:doc.sections[0].id,title:'MCP added behavior',description:'A second proposed behavior remains isolated.',criteria:['Appears only after application.'],priority:'High',status:'Draft'}}]});await reflected(doc.version);await a.locator('.proposal-diff').getByText('MCP proposed behavior',{exact:true}).first().waitFor();assert.deepEqual(doc.requirements,accepted);
      await mcpWrite('submit_proposal',{proposal_id:proposal});await reflected(doc.version);assert.deepEqual(doc.requirements,accepted);await a.getByRole('button',{name:'I reviewed latest; keep my input',exact:true}).click();
    });
    await t.test('an open apply confirmation cannot accept unseen content; another browser applies coherently',async()=>{
      await a.getByRole('button',{name:'Apply 2 changes',exact:true}).click();await mutate('proposal_review',{id:proposal,review:{decision:'request_changes',note:'Revise before review'}});await mutate('proposal_requirement',{id:proposal,requirement:{...doc.proposals[0].requirements[0],title:'New unseen proposal content'}});await mutate('proposal_submit',{id:proposal});await reflected(doc.version);
      assert.equal(await a.getByRole('button',{name:'Apply and snapshot',exact:true}).isDisabled(),true);await a.getByRole('button',{name:'Keep reviewing',exact:true}).click();await a.locator('.proposal-diff').getByText('New unseen proposal content',{exact:true}).first().waitFor();
      await reflected(doc.version,b);await b.getByRole('tab',{name:/Changes/}).click();await b.getByRole('button',{name:'Apply 2 changes',exact:true}).click();const saved=b.waitForResponse(r=>r.url().endsWith('/api/workspace')&&r.request().method()==='POST');await b.getByRole('button',{name:'Apply and snapshot',exact:true}).click();assert.equal((await saved).status(),200);await read();measurements.push(await reflected(doc.version));assert.equal(doc.proposals[0].status,'Applied');assert.deepEqual(doc.baselines[0].requirements,doc.requirements);assert.deepEqual(doc.baselines.find(x=>x.id===frozen.id),frozen);
      await a.getByRole('tab',{name:/Requirements/}).click();await a.getByRole('heading',{name:'New unseen proposal content',exact:true}).waitFor();
    });
    await t.test('MCP evidence and retries update without duplicate reports or changed frozen content',async()=>{
      await a.getByRole('tab',{name:'Verification',exact:true}).click();await read();const args={project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),evidence:{baseline:frozen.id,artifactUrl:'https://example.com/local-cp006',summary:'Independent MCP evidence arrives live.',checks:[{id:frozen.requirements[0].id,title:'Observed original snapshot',passed:true,detail:'Local browser verification.'}]}};
      const result=await mcp('record_evidence',args);await read();await reflected(doc.version);await a.getByText('Independent MCP evidence arrives live.',{exact:true}).waitFor();assert.deepEqual(await mcp('record_evidence',args),result);await read();assert.equal(doc.evidence.length,1);assert.deepEqual(doc.baselines.find(x=>x.id===frozen.id),frozen);
    });
    await t.test('unchanged checks transfer no workspace; offline/recovery preserves pending input',async()=>{
      const checks=[];const listener=r=>{if(r.url().includes('since='))checks.push(r.status());};a.on('response',listener);await wait(3300);a.off('response',listener);assert.ok(checks.length>=2);assert.ok(checks.every(s=>s===304),JSON.stringify(checks));
      await a.getByRole('tab',{name:/Requirements/}).click();await a.locator('.requirement-select').first().dblclick();const title=a.getByRole('textbox',{name:'Title',exact:true});await title.fill('Offline pending input');await contexts[0].setOffline(true);await a.getByText('Offline',{exact:true}).waitFor();await mutate('section',{section:{title:'During offline',description:''}});await contexts[0].setOffline(false);measurements.push(await reflected(doc.version));assert.equal(await title.inputValue(),'Offline pending input');await a.getByRole('button',{name:'Cancel',exact:true}).click();
    });
    await t.test('temporary server failure and access denial recover without reporting a false save',async()=>{
      await a.route('**/api/workspace?*',route=>route.request().url().includes('since=')?route.fulfill({status:503,body:'Unavailable'}):route.continue());await a.getByText('Reconnecting…',{exact:true}).waitFor({timeout:6000});await mutate('section',{section:{title:'During outage',description:''}});await a.unroute('**/api/workspace?*');await a.evaluate(()=>window.dispatchEvent(new Event('online')));await reflected(doc.version);
      await a.route('**/api/workspace?*',route=>route.request().url().includes('since=')?route.fulfill({status:403,body:'Denied'}):route.continue());await a.getByText('Action required',{exact:true}).waitFor({timeout:6000});await a.getByRole('link',{name:'Restore sign-in'}).waitFor();await a.unroute('**/api/workspace?*');await a.getByRole('button',{name:'Retry synchronization'}).click();await a.getByText('Up to date',{exact:true}).first().waitFor();
    });
    await t.test('proposal editor preserves input after remote submission and snapshot/history remain pinned',async()=>{
      await mutate('proposal',{proposal:{title:'Lifecycle preservation draft'}});await reflected(doc.version);await a.getByRole('tab',{name:/Changes/}).click();await a.locator('.proposal-list-item').filter({hasText:'Lifecycle preservation draft'}).click();await a.getByRole('button',{name:'Edit requirement batch',exact:true}).click();await a.getByRole('button',{name:'Propose edit '+doc.requirements[0].id,exact:true}).click();
      const title=a.getByRole('textbox',{name:'Title',exact:true});await title.fill('Recoverable proposed input');const id=doc.proposals[0].id;await mutate('proposal_requirement',{id,requirement:{...doc.proposals[0].requirements[0],title:'Saved from elsewhere'}});await mutate('proposal_submit',{id});await reflected(doc.version);assert.equal(await title.inputValue(),'Recoverable proposed input');await a.getByText('This proposal is now Proposed.',{exact:true}).waitFor();assert.equal(await a.getByRole('button',{name:'Save to proposal',exact:true}).isDisabled(),true);await a.getByRole('button',{name:'Cancel',exact:true}).click();
      await a.getByRole('tab',{name:'Snapshots',exact:true}).click();await a.locator('.baseline-card').filter({hasText:frozen.name}).getByRole('button',{name:'View snapshot'}).click();await a.getByRole('button',{name:'Add implementation commit'}).click();await a.getByRole('textbox',{name:/Full Git commit ID/}).fill('a'.repeat(40));
      await mutate('requirements',{requirements:[{...doc.requirements[0],description:'A newer current description, excluded from the pinned historical snapshot.'}]});await reflected(doc.version);assert.equal(await a.getByRole('textbox',{name:/Full Git commit ID/}).inputValue(),'a'.repeat(40));assert.equal(await a.getByRole('button',{name:'Save commit reference'}).isDisabled(),true);assert.equal(await a.locator('.snapshot-requirement').getByText('Accepted behavior',{exact:true}).count(),1);assert.equal(await a.locator('.snapshot-requirement').getByText('A newer current description, excluded from the pinned historical snapshot.',{exact:true}).count(),0);await a.getByRole('button',{name:'Cancel',exact:true}).click();await a.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
      await a.getByRole('tab',{name:/Requirements/}).click();await a.locator('.requirement-select').first().click();await a.locator('.inspector').getByRole('button',{name:'History of '+doc.requirements[0].id}).click();const count=await a.locator('.requirement-timeline>li').count();await mutate('requirements',{requirements:[{...doc.requirements[0],priority:'Critical'}]});await reflected(doc.version);assert.equal(await a.locator('.requirement-timeline>li').count(),count+1);await a.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    });
    await t.test('server-side conflict fetches recovery without closing the form or swapping save tokens',async()=>{
      await a.locator('.requirement-select').first().dblclick();const title=a.getByRole('textbox',{name:'Title',exact:true});await title.fill('Recover after HTTP conflict');await read();const staleVersion=doc.version;
      await a.route('**/api/workspace?*',route=>route.request().url().includes('since=')?route.fulfill({status:304}):route.continue());await mutate('section',{section:{title:'Racing with submit',description:''}});
      const rejected=a.waitForResponse(r=>r.url().endsWith('/api/workspace')&&r.request().method()==='POST');await a.getByRole('button',{name:'Save requirement',exact:true}).click();const response=await rejected;assert.equal(response.status(),409);assert.equal(response.request().postDataJSON().version,staleVersion);assert.equal(await title.inputValue(),'Recover after HTTP conflict');await a.getByRole('dialog').getByText(/Newer saved changes are available/).waitFor();
      await a.unroute('**/api/workspace?*');await reflected(doc.version);assert.equal(await a.getByRole('button',{name:'Save requirement',exact:true}).isDisabled(),true);await a.getByRole('button',{name:'Cancel',exact:true}).click();
    });
    await t.test('project switch ignores late responses with overlapping IDs and cleans up old polling',async()=>{
      const other=await rest({action:'project',name:'CP-006 Isolation '+Date.now(),prefix:'LB'});await rest({project:other.id,version:other.version,action:'section',section:{title:'Isolated project',description:''}});
      // Refresh only the selector's index through its normal project switch effect.
      await select(a,'Asteroids');await select(a,doc.name);await reflected(doc.version);
      let release,started;const held=new Promise(r=>release=r),seen=new Promise(r=>started=r);let trapped=false;
      await a.route('**/api/workspace?*',async route=>{const url=new URL(route.request().url());if(!trapped&&url.searchParams.get('project')===doc.id&&url.searchParams.has('since')){trapped=true;const result=await route.fetch();started();await held;try{await route.fulfill({response:result});}catch{}}else await route.continue();});
      await seen;await select(a,other.name);await a.getByRole('heading',{name:other.name+'.',exact:true}).waitFor();release();await wait(200);assert.equal(await a.getByRole('heading',{name:other.name+'.',exact:true}).count(),1);await a.unroute('**/api/workspace?*');await select(a,doc.name);await reflected(doc.version);
    });
    await t.test('browser suspension catches missed versions automatically after resuming',async()=>{
      const cdp=await contexts[0].newCDPSession(a);await cdp.send('Page.setWebLifecycleState',{state:'frozen'});
      try{await mutate('section',{section:{title:'During suspension',description:''}});await mutate('section',{section:{title:'Another missed commit',description:''}});}finally{await cdp.send('Page.setWebLifecycleState',{state:'active'});}
      measurements.push(await reflected(doc.version));await cdp.detach();
    });
    await t.test('a write served by another Worker appears in the receiving browser',{skip:!process.env.WONDERWORKS_SECOND_URL},async()=>{
      const second=process.env.WONDERWORKS_SECOND_URL;if(!['localhost','127.0.0.1'].includes(new URL(second).hostname))throw Error('Second Worker must also be local.');await read();
      const r=await fetch(second+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:doc.id,version:doc.version,action:'section',section:{title:'Saved by second Worker',description:'Separate process sharing durable storage.'}})});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));doc=result;measurements.push(await reflected(doc.version));await a.getByRole('heading',{name:'Saved by second Worker',exact:true}).waitFor();
    });
    await t.test('active filters and keyboard focus survive updates; compact reduced-motion view remains usable',async()=>{
      await a.getByRole('textbox',{name:'Search requirements'}).fill('unseen');await a.getByRole('textbox',{name:'Search requirements'}).focus();await mutate('requirements',{requirements:[{...doc.requirements[0],title:'No longer matches'}]});await reflected(doc.version);await a.getByRole('heading',{name:'No matching requirements'}).waitFor();assert.equal(await a.getByRole('textbox',{name:'Search requirements'}).inputValue(),'unseen');assert.equal(await a.getByRole('textbox',{name:'Search requirements'}).evaluate(el=>el===document.activeElement),true);await a.getByRole('textbox',{name:'Search requirements'}).fill('');
      await a.setViewportSize({width:390,height:844});await a.emulateMedia({reducedMotion:'reduce'});await mkdir('outputs',{recursive:true});assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Compact view must not overflow horizontally');await a.screenshot({path:'outputs/cp-006-compact.png',fullPage:true});await a.setViewportSize({width:1440,height:1000});await a.screenshot({path:'outputs/cp-006-desktop.png',fullPage:true});
    });
    assert.deepEqual(errors,[]);console.log('CP006_BROWSER_PROJECT='+doc.id);console.log('CP006_VISIBLE_UPDATE_MS='+JSON.stringify(measurements));
  }finally{await browser.close();}
});

test('an uncertain metadata save retries its original key after a newer background read',{timeout:30000},async()=>{
  let doc=await rest({action:'project',name:'CP-006 Uncertain Save '+Date.now(),prefix:'US'});
  doc=await rest({project:doc.id,version:doc.version,action:'baseline',name:'Empty frozen snapshot'});
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  try{
    await context.request.get(origin+'/signin-with-chatgpt?return_to=/');await page.goto(origin);await page.getByRole('combobox',{name:'Current project',exact:true}).click();await page.getByRole('option',{name:doc.name,exact:true}).click();await page.getByRole('tab',{name:'Snapshots',exact:true}).click();await page.getByRole('button',{name:'View snapshot'}).click();await page.getByRole('button',{name:'Add implementation commit'}).click();await page.getByRole('textbox',{name:/Full Git commit ID/}).fill('b'.repeat(40));
    let first=true;const attempts=[];
    await page.route('**/api/snapshot-implementation',async route=>{
      attempts.push(route.request().postDataJSON());if(first){first=false;const result=await route.fetch();assert.equal(result.status(),200,await result.text());await route.abort('failed');}else await route.continue();
    });
    await page.getByRole('button',{name:'Save commit reference'}).click();await page.getByRole('button',{name:'Retry original save'}).waitFor();await page.getByText(`Workspace revision ${doc.version+1} · Durable storage`,{exact:true}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:/Full Git commit ID/}).inputValue(),'b'.repeat(40));await page.getByRole('button',{name:'Retry original save'}).click();await page.getByText(/Original save confirmed/).waitFor();assert.deepEqual(attempts[0],attempts[1]);
    const current=await (await fetch(origin+'/api/workspace?project='+doc.id)).json();assert.equal(current.version,doc.version+1);assert.equal(current.snapshotImplementations[doc.baselines[0].id].history.length,1);assert.equal(await page.getByRole('textbox',{name:/Full Git commit ID/}).inputValue(),'b'.repeat(40));
  }finally{await browser.close();}
});
