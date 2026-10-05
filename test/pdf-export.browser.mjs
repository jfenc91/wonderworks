import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_ROOT??'playwright');
const origin=process.env.WONDERWORKS_TEST_URL??'http://127.0.0.1:5173';
if(!['localhost','127.0.0.1'].includes(new URL(origin).hostname))throw Error('Use loopback QA storage.');
const out='outputs/pdf';
test('BL-014 PDF controls, saved contexts, complete large specification, recovery and isolation',async t=>{
  await mkdir(out,{recursive:true});
  const rest=async body=>{const response=await fetch(origin+'/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  let doc=await rest({action:'project',name:'PDF QA café '+Date.now(),prefix:'PD'});
  const read=async()=>doc=await(await fetch(origin+'/api/workspace?project='+doc.id)).json();
  const write=async(action,data)=>{await read();doc=await rest({project:doc.id,version:doc.version,action,...data});return doc;};
  const cookie=(await fetch(origin+'/signin-with-chatgpt?return_to=/',{redirect:'manual'})).headers.get('set-cookie').split(';')[0];
  const mcp=async(name,args)=>{const response=await fetch(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',Cookie:cookie},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});const envelope=await response.json();const value=envelope.result;assert.ok(value&&!value.isError,JSON.stringify(envelope));return value.structuredContent;};
  const mutation=async(name,args)=>{await read();return mcp(name,{project_id:doc.id,expected_workspace_version:doc.version,idempotency_key:crypto.randomUUID(),...args});};
  await write('section',{section:{title:'Complete rich specification',description:'Saved section text. Every item and supporting field belongs to this captured read.'}});const section=doc.sections[0].id;
  await write('section',{section:{title:'Empty section included in contents',description:'No items yet.'}});
  const fields=(i,extra={})=>({section,title:`Readable item ${i}`,description:`Unique saved body ${i}. `+'Words that remain searchable and readable across page breaks. '.repeat(38),body_format:'markdown',criteria:[`Criterion ${i} first: preserve <literal> **marks** …`,'Criterion second: '+'Long acceptance text. '.repeat(30)],parameters:{number:i,enabled:false,string:'original value'},tags:['pdf','verification'],...extra});
  const prefix='  <literal> **stars** snake_case x < y\n\tUnicode café é λ 中文 👩🏽‍💻 … ...\n';const maxBody=prefix+'Complete source words '.repeat(2500).slice(0,50000-Array.from(prefix).length-10)+'\nFINAL END';assert.equal(Array.from(maxBody).length,50000);
  const diagram=(id,language,source,position=0)=>({id,language,source,title:`Saved ${id} caption`,alt:`Saved ${id} alternative`,position});
  const base=await mutation('create_proposal',{title:'PDF verification fixtures'}),proposal=base.proposal_id;
  const operations=Array.from({length:99},(_,i)=>({op:'add',client_ref:'item'+i,requirement:fields(i)}));
  operations[0].requirement=fields(0,{description:'## Semantic heading\n\n**Bold** and *italic* with [safe external link](https://example.com).\n\n1. Ordered first\n2. Ordered second\n\n- Unordered entry\n\n| Name | Value |\n| --- | --- |\n| café λ 中文 | complete table |\n\n```js\n  <literal> **not markup**\nconst url = "https://example.com/'+ 'long-url-'.repeat(90)+'";\n```'});
  operations[1].requirement=fields(1,{body_format:'html',description:'<h2>Safe HTML</h2><p>Before dangerous input</p><script>window.pdfAttack=1</script><img src="https://pdf-attack.invalid/secret"><a href="javascript:alert(1)">Unsafe link label</a><table><caption>Wide table caption</caption><tr>'+Array.from({length:8},(_,i)=>`<th scope="col">Column ${i}</th>`).join('')+'</tr><tr>'+Array.from({length:8},(_,i)=>`<td>Cell ${i} `+(i===0?'Tall cell words. '.repeat(650):'Saved value')+'</td>').join('')+'</tr></table><p>After full table</p>',links:['$item0']});
  operations[2].requirement=fields(2,{description:maxBody,body_format:'plain_text'});
  operations[3].requirement=fields(3,{description:'Before flow\n\n```mermaid id=fenced\nflowchart LR\n A[Start] --> B[Finish]\n```\n\nBetween diagrams\n\n```dot id=grouped\ndigraph {subgraph cluster_a {label="Group"; a;b;} a->b[label="Link"]}\n```\n\nAfter diagrams'});
  operations[4].requirement=fields(4,{description:'',diagrams:[diagram('sequence','mermaid','sequenceDiagram\n participant A as Reader\n participant B as Service\n A->>B: Request\n B-->>A: Response'),diagram('state','mermaid','stateDiagram-v2\n [*] --> Ready\n Ready --> Done: Complete\n Done --> [*]'),diagram('undirected','dot','graph {a[label="Alpha"];b[label="Beta"];a--b}') ]});
  operations[5].requirement=fields(5,{description:'A large vector graph with readable detail pages.',diagrams:[diagram('large','dot','digraph {rankdir=LR; '+Array.from({length:18},(_,i)=>`n${i}[label="Node ${i}"];`).join(' ')+Array.from({length:17},(_,i)=>`n${i}->n${i+1};`).join(' ')+'}')]});
  operations.push({op:'add',client_ref:'information',requirement:fields('information',{kind:'information',title:'Ten-source Information summary',description:'Saved non-normative summary with figure mappings.',criteria:[],parameters:{},diagrams:[diagram('summary','mermaid','flowchart TD\n A[Source] --> B[Summary]')],summarizes:Array.from({length:10},(_,i)=>({requirement_id:'$item'+i})),diagram_mappings:[{block_id:'summary',part:'Summary box',requirement_ids:['$item0','$item1']}]})});
  const staged={client_refs:{}};for(let start=0;start<operations.length;start+=30){const batch=JSON.parse(JSON.stringify(operations.slice(start,start+30)),(_key,value)=>typeof value==='string'&&value.startsWith('$')&&staged.client_refs[value.slice(1)]?staged.client_refs[value.slice(1)]:value);Object.assign(staged.client_refs,(await mutation('stage_proposal_changes',{proposal_id:proposal,operations:batch})).client_refs);}
  await mutation('submit_proposal',{proposal_id:proposal});await write('proposal_review',{id:proposal,review:{decision:'apply',note:'Reviewed synthetic PDF fixtures'}});
  const snapshot=doc.baselines[0].id;
  await writeFile(out+'/captured-snapshot.json',JSON.stringify((await mcp('get_snapshot',{project_id:doc.id,baseline_id:snapshot})).snapshot,null,2));
  const pending=await mutation('create_proposal',{title:'Pending content excluded from every PDF'});
  const r=doc.requirements[0];const {id,revision,status,...original}=r;
  await mutation('stage_proposal_changes',{proposal_id:pending.proposal_id,operations:[{op:'edit',requirement_id:id,requirement:{...original,description:'PENDING PROPOSAL CONTENT MUST NOT APPEAR'}}]});await read();
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const page=await browser.newPage({viewport:{width:1500,height:1100}});page.setDefaultTimeout(15000);
  const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  const open=async(snapshotId)=>{const dismiss=page.getByRole('button',{name:'Dismiss PDF result'});if(await dismiss.count())await dismiss.click();await page.getByRole('button',{name:snapshotId?`Download PDF ${snapshotId}`:'Download PDF',exact:true}).first().click();await page.getByRole('dialog').waitFor();};
  const download=async(name,paper='A4',snapshotId)=>{await open(snapshotId);await page.getByLabel('PDF paper size').selectOption(paper);const event=page.waitForEvent('download',{timeout:125000});await page.getByRole('dialog').getByRole('button',{name:'Download PDF',exact:true}).click();await page.getByRole('complementary',{name:'PDF download progress'}).getByText('Preparing PDF',{exact:true}).first().waitFor();const file=await event;assert.match(file.suggestedFilename(),/\.pdf$/);await file.saveAs(`${out}/${name}.pdf`);await page.getByRole('link',{name:'Download again'}).waitFor();assert.equal(await file.failure(),null);return file;};
  try{
    await page.goto(origin);await page.getByRole('combobox',{name:'Current project',exact:true}).click();await page.getByRole('option',{name:doc.name,exact:true}).click();await page.getByText(`Workspace revision ${doc.version} · Durable storage`).waitFor();
    const before=structuredClone(doc);
    await t.test('accepted A4 and Letter are complete despite filters and provide warning result',async()=>{
      await page.getByRole('textbox',{name:/Search/i}).fill('Readable item 0');await download('accepted-a4');
      await page.getByText('Completed with rendering warnings',{exact:true}).first().waitFor();
      await download('accepted-letter','LETTER');assert.deepEqual(await read(),before);assert.ok(!requests.some(u=>u.includes('pdf-attack.invalid')));
      await writeFile(out+'/captured-accepted.json',JSON.stringify(before,null,2));
    });
    await t.test('older snapshot remains frozen after accepted source and section changes',async()=>{
      await mutation('submit_proposal',{proposal_id:pending.proposal_id});await write('proposal_review',{id:pending.proposal_id,review:{decision:'apply',note:'Accepted later source for frozen comparison'}});await write('section',{section:{...doc.sections[0],description:'CURRENT SECTION MUST NOT APPEAR IN OLD SNAPSHOT'}});
      await page.getByText(`Workspace revision ${doc.version} · Durable storage`).waitFor();await page.getByRole('button',{name:'Snapshots',exact:true}).click();
      const frozen=JSON.stringify(doc.baselines.find(b=>b.id===snapshot));await download('snapshot-a4','A4',snapshot);await download('snapshot-letter','LETTER',snapshot);assert.equal(JSON.stringify((await read()).baselines.find(b=>b.id===snapshot)),frozen);
    });
    await t.test('duplicate activation, cancellation and worker failure are recoverable and read-only',async()=>{
      const saved=structuredClone(await read());await page.route('**/fonts/**',route=>route.abort());await open(snapshot);await page.getByRole('dialog').getByRole('button',{name:'Download PDF',exact:true}).click();await page.getByRole('complementary',{name:'PDF download progress'}).getByText('Failed',{exact:true}).waitFor({timeout:30000});assert.equal(await page.getByRole('link',{name:'Download again'}).count(),0);await page.unroute('**/fonts/**');
      let downloads=0;page.on('download',()=>downloads++);await open(snapshot);await page.getByRole('dialog').getByRole('button',{name:'Download PDF',exact:true}).dblclick();await page.getByRole('button',{name:'Cancel PDF'}).click();await page.getByText('Generation cancelled. No file was downloaded.').waitFor();await new Promise(r=>setTimeout(r,1500));assert.equal(downloads,0);assert.deepEqual(await read(),saved);
    });
    await t.test('deadline, project switching and a blocked automatic download never publish a stale job',async()=>{
      let unblock;const gate=new Promise(r=>unblock=r);let fontStarted;const started=new Promise(r=>fontStarted=r);
      await page.route('**/fonts/**',async route=>{fontStarted();await gate;try{await route.continue();}catch{}});
      await page.clock.install();await open(snapshot);await page.getByRole('dialog').getByRole('button',{name:'Download PDF',exact:true}).click();await started;await page.clock.fastForward(120001);
      await page.getByRole('complementary',{name:'PDF download progress'}).getByText('Failed',{exact:true}).waitFor();await page.getByText(/exceeded 120 seconds/).waitFor();assert.equal(await page.getByRole('link',{name:'Download again'}).count(),0);await page.clock.resume();unblock();await page.unroute('**/fonts/**');
      await page.evaluate(()=>{window.originalAnchorClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(!this.download)window.originalAnchorClick.call(this);};});
      await open(snapshot);await page.getByRole('dialog').getByRole('button',{name:'Download PDF',exact:true}).click();await page.getByRole('link',{name:'Download again'}).waitFor({timeout:125000});
      const retry=page.waitForEvent('download');await page.getByRole('link',{name:'Download again'}).click();await (await retry).saveAs(out+'/blocked-download-retry.pdf');await page.evaluate(()=>HTMLAnchorElement.prototype.click=window.originalAnchorClick);
      let release;const hold=new Promise(r=>release=r);await page.route('**/fonts/**',async route=>{await hold;try{await route.continue();}catch{}});
      await open(snapshot);await page.getByRole('dialog').getByRole('button',{name:'Download PDF',exact:true}).click();await page.getByRole('button',{name:'Cancel PDF'}).waitFor();
      await page.getByRole('combobox',{name:'Current project',exact:true}).click();const other=page.getByRole('option').filter({hasNotText:doc.name}).first();await other.click();await page.getByRole('complementary',{name:'PDF download progress'}).waitFor({state:'detached'});release();await page.unroute('**/fonts/**');
    });
    assert.deepEqual(errors,[]);await page.screenshot({path:out+'/download-controls.png',fullPage:false});
    await writeFile(out+'/browser-result.json',JSON.stringify({project_id:doc.id,snapshot,requirement_ids:staged.client_refs,reader:'Chromium '+browser.version(),requestsOutsideOrigin:requests.filter(u=>!u.startsWith(origin)&&!u.startsWith('blob:')),checks:'A4/Letter accepted and old snapshot, readonly, cancellation, duplicate activation, font failure, safe content',errors},null,2));
  }finally{await browser.close();}
});
