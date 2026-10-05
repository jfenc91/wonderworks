import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {acceptRequirements} from './fixtures/accepted-requirements.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_ROOT??'playwright');
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5180';
if(!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error('Use disposable loopback storage.');
const headers=process.env.WW_BROWSER_TOKEN?{Authorization:'Bearer '+process.env.WW_BROWSER_TOKEN}:{};
async function rest(body){const r=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,200,JSON.stringify(d));return d;}
test('workspace export, preview, copy and preserved review workflows through Chromium',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({acceptDownloads:true,extraHTTPHeaders:headers}),page=await context.newPage();
  let doc=await rest({action:'project',name:'Workspace transfer '+Date.now(),prefix:'TR'});
  doc=await rest({action:'section',project:doc.id,version:doc.version,section:{title:'Portable behavior',description:'Exact saved history'}});
  doc=await acceptRequirements(doc,[{section:doc.sections[0].id,title:'Portable Unicode requirement',description:'## Complete source\n\n漢字 🌍 λ **rich content**',body_format:'markdown',criteria:['Preserve the full source and revision.'],parameters:{value:1},tags:['portable'],links:[],priority:'High',status:'Draft'}],rest);
  doc=await rest({action:'proposal',project:doc.id,version:doc.version,proposal:{title:'Imported open proposal'}});
  const original=structuredClone(doc);
  try{
    // Sites emulator uses its own cookie; standalone local mode is explicit.
    await page.goto(origin+'/signin-with-chatgpt?return_to=/');await page.goto(origin);
    await page.getByRole('combobox',{name:'Current project'}).click();await page.getByRole('option',{name:doc.name,exact:true}).click();
    await page.getByRole('tab',{name:'Settings',exact:true}).click();const dialog=page.getByRole('region',{name:'Workspace backup & import',exact:true});
    await dialog.getByLabel('Export workspace scope').selectOption('current');const downloaded=page.waitForEvent('download');await dialog.getByRole('button',{name:'Export workspace',exact:true}).click();const download=await downloaded;
    await mkdir('outputs/bl015-browser',{recursive:true});const file='outputs/bl015-browser/'+new URL(origin).port+'.wwspace';await download.saveAs(file);assert.ok((await readFile(file)).length>100);
    await dialog.getByText(/Ready: 1 workspace/).waitFor();await dialog.getByLabel('Workspace archive',{exact:true}).setInputFiles(file);await dialog.getByRole('button',{name:'Preview archive',exact:true}).click();
    await dialog.getByText('This ID already exists. Import a copy or skip.').waitFor();await dialog.getByLabel('Import mode for '+doc.name).selectOption('copy');
    await dialog.getByRole('button',{name:'Confirm selected imports',exact:true}).click();await dialog.getByText('Import complete. Historical assertions are labeled as imported provenance.').waitFor();const index=await (await fetch(origin+'/api/workspace?index=1',{headers})).json();const imported=index.filter(p=>p.name===doc.name&&p.id!==doc.id);assert.equal(imported.length,1);const id=imported[0].id;
    await dialog.getByRole('button',{name:'Open '+doc.name,exact:true}).click();await page.getByText('Imported workspace',{exact:true}).waitFor();await page.getByRole('heading',{name:'Portable Unicode requirement',exact:true}).first().waitFor();
    const copy=await (await fetch(origin+'/api/workspace?project='+id,{headers})).json();assert.deepEqual({...copy,id:doc.id},original);
    assert.deepEqual(await (await fetch(origin+'/api/workspace?project='+doc.id,{headers})).json(),original);
    await page.screenshot({path:'outputs/bl015-browser/'+new URL(origin).port+'-import.png',fullPage:true});
    await page.getByRole('button',{name:'Change proposals',exact:false}).first().click();await page.getByText('Imported open proposal',{exact:true}).first().waitFor();
    await page.goto(origin+'/integrations');await page.getByText(/18 tools/).waitFor();assert.ok((await page.locator('main').innerText()).includes('/mcp'));
  }finally{await browser.close();}
});
