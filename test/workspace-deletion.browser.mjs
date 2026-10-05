import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_ROOT??'playwright');
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5290';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error('Use disposable loopback storage only.');
const headers=process.env.WW_BROWSER_TOKEN?{Authorization:'Bearer '+process.env.WW_BROWSER_TOKEN}:{};
async function rest(body){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
async function read(id){const r=await fetch(origin+'/api/workspace?project='+id,{headers});assert.equal(r.status,200);return r.json();}
async function remove(doc){const r=await fetch(origin+'/api/workspace-deletion',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID()})});assert.equal(r.status,200,await r.text());}
test('confirmation, export failure/download, stale confirmation, remote input recovery and last-project navigation',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({acceptDownloads:true,extraHTTPHeaders:headers}),remote=await browser.newContext({extraHTTPHeaders:headers});
  const page=await context.newPage(),other=await remote.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));other.on('pageerror',e=>errors.push(e.message));
  const name='Delete QA '+Date.now();let doc=await rest({action:'project',name,prefix:'DEL'});const kept=await rest({action:'project',name,prefix:'KEEP'});
  await rest({action:'section',project:kept.id,version:kept.version,section:{title:'Preserved section',description:''}});
  doc=await rest({action:'section',project:doc.id,version:doc.version,section:{title:'Delete section',description:'Saved content'}});
  try{
    for(const p of [page,other]){await p.goto(origin+'/signin-with-chatgpt?return_to=/');await p.goto(origin+'/?project='+doc.id);await p.getByRole('heading',{name:doc.name+'.',exact:true}).waitFor();}
    await other.getByRole('button',{name:'New requirement',exact:true}).click();await other.getByLabel('Title',{exact:true}).fill('Preserve my unsaved deletion draft');
    await page.getByRole('tab',{name:'Settings',exact:true}).click();
    const open=async()=>{await page.getByRole('button',{name:'Delete workspace',exact:true}).click();return page.getByRole('dialog');};
    let dialog=await open();assert.ok((await dialog.textContent()).includes(doc.id));assert.ok((await dialog.textContent()).includes('DEL'));
    assert.equal(await dialog.getByRole('button',{name:'Cancel',exact:true}).evaluate(e=>e===document.activeElement),true);
    await dialog.getByLabel('Project name to confirm deletion').fill('wrong');assert.equal(await dialog.getByRole('button',{name:'Delete workspace',exact:true}).isDisabled(),true);
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal((await read(doc.id)).version,doc.version);
    dialog=await open();
    await page.route('**/api/workspace-archive?scope=*',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Injected export failure"}'}));
    await dialog.getByRole('button',{name:'Export workspace first'}).click();await dialog.getByRole('alert').waitFor();assert.equal((await read(doc.id)).version,doc.version);await page.unroute('**/api/workspace-archive?scope=*');
    const downloaded=page.waitForEvent('download');await dialog.getByRole('button',{name:'Export workspace first'}).click();const archivePath=await (await downloaded).path();await dialog.getByRole('status').filter({hasText:'Workspace archive downloaded'}).waitFor();
    await dialog.getByLabel('Project name to confirm deletion').fill(name);
    doc=await rest({action:'section',project:doc.id,version:doc.version,section:{title:'Concurrent section',description:''}});
    await dialog.getByRole('alert').filter({hasText:'The workspace changed'}).waitFor();assert.equal(await dialog.getByRole('button',{name:'Delete workspace',exact:true}).isDisabled(),true);
    await dialog.getByRole('button',{name:'Cancel and review workspace'}).click();await page.getByRole('button',{name:'Edit AI guidance',exact:true}).click();await page.getByLabel('Custom project instructions',{exact:true}).fill('Local unsaved guidance to discard explicitly');dialog=await open();await dialog.getByLabel('Project name to confirm deletion').fill(name);assert.equal(await dialog.getByRole('button',{name:'Delete workspace',exact:true}).isDisabled(),true);await dialog.getByRole('checkbox').check();
    await mkdir('outputs/bl016',{recursive:true});await dialog.getByRole('button',{name:'Delete workspace',exact:true}).waitFor();await page.screenshot({path:'outputs/bl016/deletion-confirmation.png',animations:'disabled'});await page.setViewportSize({width:390,height:844});const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=391&&bounds.y+bounds.height<=845);await page.screenshot({path:'outputs/bl016/deletion-mobile.png',animations:'disabled'});await page.setViewportSize({width:1280,height:720});
    const start=Date.now();await dialog.getByRole('button',{name:'Delete workspace',exact:true}).click();await page.getByRole('heading',{name:'Choose a workspace',exact:true}).waitFor();
    await other.getByLabel('Recovered unsaved input').waitFor({timeout:5000});assert.ok(Date.now()-start<5000);assert.match(await other.getByLabel('Recovered unsaved input').inputValue(),/Preserve my unsaved deletion draft/);
    assert.equal(await other.getByRole('button',{name:'Save requirement',exact:true}).count(),0);await other.screenshot({path:'outputs/bl016/recovered-input.png',fullPage:true});
    await other.getByRole('button',{name:'Discard recovered input'}).click();
    assert.equal((await read(kept.id)).name,kept.name);
    await other.getByLabel('Current project',{exact:true}).selectOption(kept.id);await other.getByRole('button',{name:'New requirement',exact:true}).click();await other.getByLabel('Title',{exact:true}).fill('Keep input while inactive project disappears');
    const inactive=await rest({action:'project',name:'Inactive deletion QA',prefix:'OFF'});await other.getByRole('combobox',{name:'Current project',exact:true}).click();await other.getByRole('option',{name:inactive.name,exact:true}).waitFor();await remove(inactive);await other.getByRole('option',{name:inactive.name,exact:true}).waitFor({state:'detached',timeout:5000});await other.keyboard.press('Escape');assert.equal(await other.getByLabel('Title',{exact:true}).inputValue(),'Keep input while inactive project disappears');assert.equal(await other.locator('.project-tag').textContent(),'KEEP');
    await page.reload();await page.getByRole('heading',{name:'Choose a workspace',exact:true}).waitFor();
    // This suite owns the entire disposable test deployment.
    const index=await (await fetch(origin+'/api/workspace?index=1',{headers})).json();for(const item of index)await remove(await read(item.id));
    await page.getByRole('heading',{name:'No workspaces yet',exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'No workspaces yet',exact:true}).waitFor();
    await page.getByLabel('Workspace archive',{exact:true}).setInputFiles(archivePath);await page.getByRole('button',{name:'Preview archive',exact:true}).click();await page.getByText('This ID is reserved after deletion. Import a copy or skip.',{exact:true}).waitFor();await page.getByLabel('Import mode for '+name,{exact:true}).selectOption('copy');await page.getByRole('button',{name:'Confirm selected imports',exact:true}).click();await page.getByRole('button',{name:'Open '+name,exact:true}).click();await page.getByRole('heading',{name:name+'.',exact:true}).waitFor();const importedId=new URL(page.url()).searchParams.get('project');assert.notEqual(importedId,doc.id);await remove(await read(importedId));await page.getByRole('heading',{name:'No workspaces yet',exact:true}).waitFor();
    await page.getByRole('button',{name:'Create project',exact:true}).click();await page.getByLabel('Project name',{exact:true}).fill('Created after last deletion');await page.getByRole('button',{name:'Save project',exact:true}).click();await page.getByRole('heading',{name:'Created after last deletion.',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
