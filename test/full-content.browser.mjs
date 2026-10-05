import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {acceptRequirements} from './fixtures/accepted-requirements.mjs';

const {chromium} = await import(process.env.PLAYWRIGHT_ROOT ?? 'playwright');
const origin = process.env.WONDERWORKS_TEST_URL ?? 'http://127.0.0.1:5173';
const mcpOrigin = process.env.WONDERWORKS_MCP_URL ?? origin;
for (const url of [origin, mcpOrigin]) if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw Error('Use loopback QA storage.');
const examples = JSON.parse(await readFile(new URL('./fixtures/bl012-reading.json', import.meta.url)));
const wideCode = 'const snake_case = "' + 'wide_content_'.repeat(100) + '";';
const markdown = '## Complete heading 👩🏽‍💻\n\n**Strong** and *emphasis* with [safe link](https://example.com).\n\n> Quoted content\n\n1. First\n2. Second\n\n- Unordered item\n\n| ' + Array.from({length:12}, (_,i) => 'Column '+i).join(' | ') + ' |\n|' + '---|'.repeat(12) + '\n| ' + Array.from({length:12}, (_,i) => '`snake_case_'+i+'`').join(' | ') + ' |\n\n```js\n' + wideCode + '\n```\n\n' + 'Complete words é 👨‍👩‍👧‍👦 remain intact. '.repeat(60) + '\n\nAuthored ellipsis… and three periods... Final complete body.';
const html = '<h2>Safe HTML heading</h2><p>Literal &lt; comparison and snake_case</p><table><caption>Saved table</caption><tr><th>Cell</th></tr><tr><td>Final value</td></tr></table><script>window.bl013Attack=1</script><img src="https://bl013-attack.example/a">';
const plainPrefix = '  <literal> **stars** snake_case x < y\n\tSpaces  and Unicode 👩🏽‍💻 … ...\n';
const maxBody = plainPrefix + 'all saved words '.repeat(3400).slice(0, 50000 - Array.from(plainPrefix).length - 11) + '\nFINAL BODY';
assert.equal(Array.from(maxBody).length, 50000);
async function rest(body) {
  const response = await fetch(origin + '/api/workspace', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}

test('BL013 complete main items, independent persisted contexts, keyboard and compact reading', async t => {
  let doc = await rest({action:'project', name:'BL013 complete content '+Date.now(), prefix:'FC'});
  const read = async () => doc = await (await fetch(origin+'/api/workspace?project='+doc.id)).json();
  const write = async (action, data={}) => {await read(); return doc = await rest({project:doc.id, version:doc.version, action, ...data});};
  await write('section', {section:{title:'Complete inline specification',description:'Full saved fields and diagrams'}});
  const req = (title, description, extra={}) => ({section:doc.sections[0].id,title,description,body_format:'markdown',criteria:['First <literal> criterion **markers** …','Second criterion with snake_case and x < y...'],parameters:{snake_case:42, enabled:false, long_value:'All values remain visible'},tags:['reading','unicode'],...extra});
  const diagram = (id, language, source, position=0) => ({id,language,source,position,title:'Complete '+id,alt:'Accessible alternative for '+id});
  const prefix = 'Before diagrams 👩🏽‍💻.\n\n', middle = 'Between diagrams.\n\n';
  doc = await acceptRequirements(doc, [
    req('Full title <literal> **markers** … ... '+ 'long Unicode title '.repeat(4), markdown),
    req('Semantic HTML', html, {body_format:'html',links:['FC-001']}),
    req('Maximum supported body',maxBody,{body_format:'plain_text',links:['FC-001','FC-002']}),
    req('Multiple diagrams',prefix+middle+'After diagrams.', {diagrams:[diagram('flow','mermaid','flowchart TD\n A[Start] --> B[Finish]',Array.from(prefix).length),diagram('graph','dot','digraph {a[label="Graph start"];a->b[label="Graph finish"]}',Array.from(prefix+middle).length)]}),
    req('Diagram only','',{diagrams:[diagram('only','dot','digraph {a[label="Only start"];a->b[label="Only finish"]}')]}),
    ...examples.map((example, index) => req(example.title, example.description, index===0 ? {} : {kind:'information',criteria:[],parameters:{},diagrams:example.diagrams??[],summarizes:[{requirement_id:'FC-001'},{requirement_id:'FC-002'}],diagram_mappings:(example.diagram_mappings??[]).map(m=>({...m,requirement_ids:['FC-001','FC-002']}))})),
  ], rest);
  await write('proposal',{proposal:{title:'Other proposal'}}); const other = doc.proposals[0].id;
  await write('proposal',{proposal:{title:'Complete staged items'}}); const destination = doc.proposals[0].id;
  await write('proposal_requirement',{id:destination,requirement:{...doc.requirements[0],description:markdown+'\n\nStaged tail … ...',criteria:['Staged first criterion','Staged second criterion'],parameters:{stage:'retained'},tags:['staged']}});
  await write('proposal_requirement',{id:destination,requirement:req('Failed block stays visible','Before failure.\n\nAfter failure.',{diagrams:[diagram('broken','mermaid','flowchart TD\n ???',17)]})});
  const broken = doc.proposals[0].requirements.at(-1).id;
  const protectedState = () => ({requirements:doc.requirements,baselines:doc.baselines,evidence:doc.evidence,requirementsVersion:doc.requirementsVersion,other:doc.proposals.find(p=>p.id===other)});
  const frozen = structuredClone(protectedState()), initialVersion = doc.version;
  const cookie = (await fetch(mcpOrigin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  const mcp = async (name,args) => {
    const response = await fetch(mcpOrigin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',Cookie:cookie},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});
    const result = (await response.json()).result;assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent;
  };
  const browser = await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page = await browser.newPage({viewport:{width:1500,height:1100}}), errors=[], requests=[];
  page.on('pageerror', e=>errors.push(e.message));page.on('request', r=>requests.push(r.url()));page.setDefaultTimeout(10000);
  const row = id=>page.locator('.requirement-row').filter({has:page.locator('#requirement-title-'+id)});
  const reflected = async()=>page.getByText(`Workspace revision ${doc.version} · Durable storage`,{exact:true}).waitFor({state:'attached'});
  const persisted = async id=>(await mcp('get_requirement',{project_id:doc.id,requirement_id:id})).requirement;
  const noPageOverflow = async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await mkdir('outputs',{recursive:true});
  try {
    await page.goto(origin);await page.getByRole('combobox',{name:'Current project',exact:true}).click();await page.getByRole('option',{name:doc.name,exact:true}).click();await reflected();
    await t.test('all accepted fields and rich semantics are inline without selecting or expanding an item', async()=>{
      const first = row('FC-001');const stored = await persisted('FC-001');
      await first.locator('.semantic-body').getByText(/Final complete body/).waitFor();
      assert.equal(await first.locator('.requirement-title').textContent(),stored.title);
      assert.deepEqual(await first.locator('.inline-criteria li').allTextContents(),stored.criteria);
      assert.deepEqual(await first.locator('.parameters dt').allTextContents(),Object.keys(stored.parameters));
      assert.deepEqual(await first.locator('.parameters dd').allTextContents(),Object.values(stored.parameters).map(String));
      assert.deepEqual(await first.locator('.requirement-tag').allTextContents(),stored.tags);
      for(const selector of ['h2','strong','em','a','blockquote','ol','ul','table','pre code']) assert.ok(await first.locator('.semantic-body '+selector).count(),selector);
      assert.equal(await first.locator('.semantic-body pre code').textContent(),wideCode+'\n');
      assert.equal(await first.locator('.semantic-body td').count(),12);
      assert.match(await first.locator('.source-links').textContent(),/Summarized by.*Information/s);
      assert.match(await row('FC-007').locator('.source-links').textContent(),/Sources.*FC-001.*FC-002.*Diagram source navigation/s);
      assert.match(await row('FC-007').locator('.requirement-meta').textContent(),/Information · Non-normative/);
      assert.equal(await page.locator('.requirement-excerpt,.requirement-row.selected').count(),0);
      assert.equal(await row('FC-002').locator('.semantic-body script,.semantic-body img').count(),0);
      await row('FC-002').getByRole('heading',{name:'Safe HTML heading'}).waitFor();
      assert.equal(await page.evaluate(()=>window.bl013Attack),undefined);assert.ok(!requests.some(url=>url.includes('bl013-attack.example')));
      assert.equal(await row('FC-003').locator('.plain-body').textContent(),(await persisted('FC-003')).description);
      assert.deepEqual(await row('FC-003').locator('.inline-dependencies button').allTextContents(),['FC-001 · '+stored.title,'FC-002 · Semantic HTML']);
      await first.scrollIntoViewIfNeeded();await page.screenshot({path:'outputs/bl013-desktop-inline.png'});
    });
    await t.test('complete diagrams retain saved positions, captions, alternatives and source access',async()=>{
      const multi=row('FC-004');await multi.locator('figure svg').nth(1).waitFor();
      assert.deepEqual(await multi.locator('.rich-content>.semantic-body,.rich-content>figure').evaluateAll(nodes=>nodes.map(n=>n.matches('figure')?n.dataset.blockId:n.textContent.trim())),['Before diagrams 👩🏽‍💻.','flow','Between diagrams.','graph','After diagrams.']);
      await row('FC-005').locator('figure svg').waitFor();
      for(const figure of await multi.locator('figure').all()) {assert.match(await figure.locator('figcaption').textContent(),/Complete/);assert.match(await figure.locator(':scope>p').textContent(),/Accessible alternative/);}
      await multi.locator('figure').first().getByText('Original diagram source',{exact:true}).click();
      assert.equal(await multi.locator('figure').first().locator('pre').textContent(),doc.requirements[3].diagrams[0].source);
      await multi.locator('figure').first().getByLabel('Scale flow').selectOption('4');
      assert.ok(await multi.locator('.diagram-scroll').first().evaluate(el=>el.scrollWidth>el.clientWidth));
      await multi.locator('figure').first().getByLabel('Scale flow').selectOption('1');
    });
    await t.test('desktop and compact pages reach every field, maximum body and wide content with keyboard scrolling',async()=>{
      for(const width of [1500,390]) {
        await page.setViewportSize({width,height:900});await noPageOverflow();
        const maximum=row('FC-003').locator('.plain-body');
        assert.equal(await maximum.textContent(),maxBody);
        assert.ok(await maximum.evaluate(el=>el.scrollHeight<=el.clientHeight+1));
        await row('FC-003').locator('.inline-dependencies').scrollIntoViewIfNeeded();
        assert.ok(await row('FC-003').locator('.inline-dependencies').isVisible());
        for(const selector of ['.rich-scroll','.semantic-body pre']) {
          const scroll=row('FC-001').locator(selector).first();await scroll.focus();
          assert.equal(await scroll.getAttribute('tabindex'),'0');
          assert.ok(await scroll.evaluate(el=>el.scrollWidth>el.clientWidth));
          await page.keyboard.press('ArrowRight');await page.waitForFunction(el=>el.scrollLeft>0,await scroll.elementHandle());
          assert.equal(await scroll.evaluate(el=>el===document.activeElement),true);
        }
        for(const item of await page.locator('.requirement-row').all()) assert.ok(await item.evaluate(el=>{const css=getComputedStyle(el);return css.maxHeight==='none'&&css.webkitLineClamp==='none'&&el.scrollHeight<=el.clientHeight+1;}));
        await row('FC-001').scrollIntoViewIfNeeded();await page.screenshot({path:`outputs/bl013-inline-${width}.png`});await noPageOverflow();
      }
      assert.equal((await read()).version,initialVersion);assert.deepEqual(protectedState(),frozen);
    });
    await t.test('staged full fields and failure fallback use saved proposal content, then refresh coherently without losing dirty input',async()=>{
      await page.getByLabel('Working requirements',{exact:true}).selectOption(destination);
      await row('FC-001').getByText(/Staged tail/).first().waitFor();
      const saved=(await mcp('get_proposal',{project_id:doc.id,proposal_id:destination})).proposal.requirements.find(r=>r.id==='FC-001');
      assert.deepEqual(await row('FC-001').locator('.inline-criteria li').allTextContents(),saved.criteria);
      assert.deepEqual(await row('FC-001').locator('.parameters dd').allTextContents(),['retained']);
      assert.deepEqual(await row('FC-001').locator('.requirement-tag').allTextContents(),saved.tags);
      await row(broken).getByText(/Block broken: Unsupported/).waitFor();
      assert.equal(await row(broken).locator('figure details[open] pre').textContent(),'flowchart TD\n ???');
      assert.match(await row(broken).locator('.rich-content').textContent(),/Before failure.*After failure/s);
      await page.setViewportSize({width:1500,height:1100});await row('FC-001').locator('.requirement-select').dblclick();
      await page.getByLabel('Description',{exact:true}).fill('Unsaved input survives … ...');
      const {id,revision,status,...fields}=saved;
      await read();await mcp('stage_proposal_changes',{project_id:doc.id,proposal_id:destination,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),operations:[{op:'edit',requirement_id:id,requirement:{...fields,description:markdown+'\n\nRemote complete tail',criteria:['Remote first','Remote second'],parameters:{remote:true},tags:['remote']}}]});
      await read();await reflected();await row(id).getByText(/Remote complete tail/).first().waitFor({state:'attached'});
      assert.equal(await page.getByLabel('Description',{exact:true}).inputValue(),'Unsaved input survives … ...');
      assert.deepEqual(await row(id).locator('.inline-criteria li').allTextContents(),['Remote first','Remote second']);
      assert.deepEqual(await row(id).locator('.parameters dd').allTextContents(),['true']);
      assert.ok(await page.getByRole('button',{name:'Save to proposal',exact:true}).isDisabled());
      await page.locator('.requirement-editor').getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Discard',exact:true}).click();
      await page.reload();await page.getByRole('combobox',{name:'Current project',exact:true}).click();await page.getByRole('option',{name:doc.name,exact:true}).click();await reflected();
      assert.equal(await row('FC-001').getByText(/Remote complete tail/).count(),0);
      await page.getByLabel('Working requirements',{exact:true}).selectOption(destination);await row('FC-001').getByText(/Remote complete tail/).first().waitFor();
      const latest=(await mcp('get_proposal',{project_id:doc.id,proposal_id:destination})).proposal.requirements.find(r=>r.id==='FC-001');
      assert.equal(latest.description,markdown+'\n\nRemote complete tail');assert.equal(latest.revision,saved.revision);
      await read();assert.deepEqual(protectedState(),frozen);
    });
    assert.deepEqual(errors,[]);
    await writeFile('outputs/bl013-browser-result.json',JSON.stringify({project_id:doc.id,proposal_id:destination,workspace_version:doc.version,independent_mcp_readback:true,maximum_body_code_points:50000},null,2));
  } finally {await browser.close();}
});
