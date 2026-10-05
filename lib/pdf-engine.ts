/* PDFKit's font, structure and annotation bridges below use its pinned 0.17.2
 * internals; integration tests inspect the resulting PDF objects. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import PDFDocument from 'pdfkit/js/pdfkit.standalone.js';
import SVGtoPDF from 'svg-to-pdfkit';
import {decodeHTML} from 'entities';
import {PDF_LIMITS,safePdfLink,type Block,type Run,type PdfModel} from './pdf-model';
import {normalizeTags} from './tags';

export const PDF_FONTS:Record<string,string>={Regular:'NotoSans-Regular.ttf',Bold:'NotoSans-Bold.ttf',Italic:'NotoSans-Italic.ttf',Mono:'NotoSansMono-Regular.ttf',Symbols:'NotoSansSymbols2-Regular.ttf',CJK:'NotoSansCJKsc-Regular.otf',Emoji:'NotoEmoji.ttf'};
type Fragment=Run&{font:string;width:number};
type Line=Fragment[];
const margin=46,top=76,bottom=66;
const textBlock=(text:string,size=11,role='P'):Block=>({type:'text',runs:[{text}],size,role});
const flatten=(blocks:Block[]):Run[]=>blocks.flatMap(b=>b.type==='text'?[...b.runs,{text:'\n'}]:b.type==='list'?b.items.flatMap((v,i)=>[{text:`${b.ordered?b.start+i+'.':'•'} `},...flatten(v)]):b.type==='table'?b.rows.flatMap(row=>row.cells.flatMap(flatten)):[{text:`${b.title}\n${b.alt}\n${b.source}`}]);

/** All layout is derived; no workspace APIs or external resources are used. */
export async function buildPdf(model:PdfModel,fonts:Record<string,Uint8Array>,progress:(message:string)=>void=()=>{}):Promise<Uint8Array>{
  const {source}=model;
  const doc:any=new PDFDocument({autoFirstPage:false,bufferPages:true,pdfVersion:'1.7',tagged:true,displayTitle:true,lang:source.language,info:{Title:`${source.projectName} — Product specification — ${source.context}`,Author:'Wonderworks',Subject:source.context,CreationDate:new Date(source.generated)}});
  const chunks:Uint8Array[]=[];let bytes=0;
  const result=new Promise<Uint8Array>((resolve,reject)=>{doc.on('data',(c:Uint8Array)=>{bytes+=c.length;if(bytes>PDF_LIMITS.outputBytes){reject(Error('PDF output exceeds 64 MB. Use the existing source export.'));doc.destroy();}else chunks.push(c);});doc.on('error',()=>reject(Error('PDF assembly failed. Retry the export.')));doc.on('end',()=>{const all=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}resolve(all);});});
  // Avoid an unhandled rejection if layout fails before stream completion.
  void result.catch(()=>{});
  for(const [name,data] of Object.entries(fonts))doc.registerFont(name,data);
  const fontObjects=new Map<string,any>();for(const name of Object.keys(fonts)){doc.font(name);fontObjects.set(name,doc._font.font);}
  const glyphCache=new Map<string,string>(),widthCache=new Map<string,number>();
  const graphemes=new Intl.Segmenter('en',{granularity:'grapheme'});
  function fontFor(text:string,style:Run):string{
    const preferred=style.code?'Mono':style.bold?'Bold':style.italic?'Italic':'Regular';const key=preferred+text;
    if(glyphCache.has(key))return glyphCache.get(key)!;
    // Variation selectors and joiners are shaped with their surrounding cluster.
    const points=Array.from(text).map(c=>c.codePointAt(0)!).filter(c=>c!==0x200d&&c!==0xfe0f&&c!==0xfe0e);
    const name=[preferred,'Regular','Symbols','CJK','Emoji'].find(n=>points.every(c=>fontObjects.get(n)?.hasGlyphForCodePoint(c)));
    if(!name)throw Error(`No embedded font covers U+${points.find(c=>!Array.from(fontObjects.values()).some(f=>f.hasGlyphForCodePoint(c)))?.toString(16).toUpperCase()??'cluster'}. Use the source export or supported Unicode characters.`);
    glyphCache.set(key,name);return name;
  }
  function width(text:string,font:string,size:number){const key=font+':'+size+':'+text;if(!widthCache.has(key)){doc.font(font).fontSize(size);widthCache.set(key,doc.widthOfString(text));}return widthCache.get(key)!;}
  function fragments(run:Run,size:number):Fragment[]{
    const out:Fragment[]=[];for(const {segment} of graphemes.segment(run.text.replace(/\t/g,'    '))){const font=fontFor(segment,run),last=out.at(-1);if(last?.font===font)last.text+=segment;else out.push({...run,text:segment,font,width:0});}
    for(const f of out)f.width=width(f.text,f.font,size);return out;
  }
  function lines(runs:Run[],size:number,maxWidth:number,literal=false):Line[]{
    const output:Line[]=[];let line:Line=[],used=0,lastSpace=false;
    const push=()=>{output.push(line);line=[];used=0;};
    for(const input of runs){
      const sourceText=literal?input.text:input.text.replace(/[\t\r ]+/g,' ');
      for(const token of sourceText.split(/(\n|[^\S\n]+|[^\s]+)/u).filter(Boolean)){
        if(token==='\n'){push();lastSpace=false;continue;}
        const space=/^\s+$/.test(token);if(!literal&&space&&(lastSpace||!line.length))continue;lastSpace=space;
        const pieces=fragments({...input,text:token},size),w=pieces.reduce((n,f)=>n+f.width,0);
        if(used+w>maxWidth&&line.length){push();if(!literal&&space)continue;}
        if(w<=maxWidth){line.push(...pieces);used+=w;continue;}
        for(const piece of pieces)for(const {segment} of graphemes.segment(piece.text)){const cw=width(segment,piece.font,size);if(cw>maxWidth)throw Error('A text column is too narrow. Use the source export.');if(used+cw>maxWidth&&line.length)push();const last=line.at(-1);if(last&&last.font===piece.font&&last.href===piece.href&&last.bold===piece.bold&&last.italic===piece.italic){last.text+=segment;last.width=width(last.text,last.font,size);used=line.reduce((n,f)=>n+f.width,0);}else {line.push({...piece,text:segment,width:cw});used+=cw;}}
      }
    }
    if(line.length||!output.length)push();return output;
  }
  const root=doc.struct('Document');doc.addStructure(root);
  let y=top,page=0,currentItem='';const pageItems:string[]=[],sectionPages=new Map<string,number>();
  let parent:any=root;
  const makeStruct=(role:string,p:any=parent,options:Record<string,unknown>={})=>{const s=doc.struct(role,options);p.add(s);return s;};
  const pageWidth=()=>doc.page.width-2*margin;
  const endY=()=>doc.page.height-bottom;
  function newPage(){if(++page>PDF_LIMITS.pages)throw Error(`PDF exceeds ${PDF_LIMITS.pages} pages. Use the existing source export.`);doc.addPage({size:source.paper,margin});doc.page.dictionary.data.Tabs='S';y=top;pageItems[page-1]=currentItem?`${currentItem} · continued`:'';}
  function ensure(height:number){if(y+height>endY())newPage();}
  function anchor(id:string){doc.addNamedDestination(id,'XYZ',margin,doc.page.height-y,null);}
  function annotation(struct:any,href:string,x:number,y:number,w:number,h:number){
    const key=doc.createStructParentTreeNextKey();doc.getStructParentTree().add(key,struct.dictionary);
    const action=doc.ref(href.startsWith('#')?{S:'GoTo',D:new String(href.slice(1))}:{S:'URI',URI:new String(href)});action.end();
    doc.annotate(x,y,w,h,{Subtype:'Link',A:action,StructParent:key});const ref=doc.page.annotations.at(-1);
    const dictionary=struct.dictionary,finish=dictionary.end.bind(dictionary),pg=doc.page.dictionary;
    dictionary.end=()=>{dictionary.data.K.push({Type:'OBJR',Obj:ref,Pg:pg});finish();};
  }
  function drawLine(line:Line,x:number,at:number,size:number,struct:any,artifact=false){
    const merged:Fragment[]=[];for(const fragment of line){const last=merged.at(-1);if(last&&last.font===fragment.font&&last.href===fragment.href){last.text+=fragment.text;last.width+=fragment.width;}else merged.push({...fragment});}
    for(const f of merged){
      if(artifact)doc.markContent('Artifact',{type:'Pagination'});
      const href=f.href?.startsWith('#')?f.href:safePdfLink(f.href??'');
      const span=artifact?null:makeStruct(href?'Link':'Span',struct);
      if(span)span.add(doc.markStructureContent(href?'Link':'Span'));
      doc.font(f.font).fontSize(size).fillColor('#18232b').text(f.text,x,at,{lineBreak:false,features:['liga']});
      doc.endMarkedContent();if(href&&span)annotation(span,href,x,at,f.width,size*1.4);x+=f.width;
    }
  }
  function paragraph(runs:Run[],size=11,role='P',literal=false,x=margin,w=pageWidth(),p=parent){
    const ls=lines(runs,size,w,literal),lh=size*1.4,heading=/^H[1-6]$/.test(role);
    if(heading)ensure(ls.length*lh+2*15.4+8);else if(ls.length>=4)ensure(lh*2);
    const s=makeStruct(role,p);
    for(let i=0;i<ls.length;i++){
      if(ls.length>=4&&i===ls.length-2&&y+lh*2>endY())newPage();else ensure(lh);
      drawLine(ls[i],x,y,size,s);y+=lh;
    }
    y+=heading?8:7;
  }
  const plain=(text:string,size=11,role='P')=>paragraph([{text}],size,role);
  const preparedFigures=new Map<Block,string>();
  function figureSvg(b:Extract<Block,{type:'figure'}>){
    // SVG width/height are viewport hints; normalize them so the PDF viewport
    // controls the physical figure size (Graphviz commonly emits pt units).
    return b.svg!.replace(/<svg\b([^>]*)>/,(_m,attrs)=>`<svg${attrs.replace(/\s(?:width|height)="[^"]*"/g,'')} width="100%" height="100%">`).replace(/(<text\b[^>]*)(>)([\s\S]*?)(<\/text>)/g,(_m,a,close,body,end)=>{
      const points=Array.from(decodeHTML(body.replace(/<[^>]*>/g,''))).map(c=>c.codePointAt(0)!);
      const font=['Regular','CJK','Symbols','Emoji'].find(n=>points.every(c=>fontObjects.get(n)?.hasGlyphForCodePoint(c)));
      if(!font)throw Error('The PDF fonts do not cover a diagram label.');
      return a.replace(/\sfont-family="[^"]*"/g,'')+` font-family="${font}"`+close+body+end;
    });
  }
  const svgOptions={assumePt:true,fontCallback:(family:string)=>fontObjects.has(family)?family:'Regular',imageCallback:()=>{throw Error('Images are not permitted in PDF diagrams.');},documentCallback:()=>{throw Error('External SVG resources are not permitted.');},warningCallback:()=>{throw Error('The PDF vector renderer does not support this diagram output.');}};
  function table(block:Extract<Block,{type:'table'}>,x=margin,w=pageWidth()){
    if(!block.rows.length)return;
    if(block.caption)plain(block.caption,10,'Caption');
    const columns=Math.max(...block.rows.map(r=>r.cells.length));
    // Wide tables are printed as numbered column bands. Row numbers keep
    // associations explicit while preserving 10-point text and every cell.
    for(let start=0;start<columns;start+=5){
      const count=Math.min(5,columns-start),wide=columns>5,cw=w/(count+(wide?0.45:0)),labelW=wide?cw*0.45:0;
      if(wide)plain(`Table columns ${start+1}–${start+count} of ${columns} · same row numbers across bands`,9.5);
      const s=makeStruct('Table'),headerIds:string[]=[],headerRows=block.rows.filter((r,i)=>r.header&&i===0);
      const renderRow=(row:typeof block.rows[number],index:number,repeat=false)=>{
        const cellLines=Array.from({length:count},(_,c)=>lines(flatten(row.cells[start+c]??[]).map(r=>({...r,bold:r.bold||row.header})),10,cw-12,true));
        const full=Math.max(1,...cellLines.map(ls=>ls.length)),lh=14;
        if(full*lh+12<=endY()-top-60&&y+full*lh+12>endY()){newPage();if(!row.header)for(const h of headerRows)renderRow(h,0,true);}
        const tr=repeat?null:makeStruct('TR',s),cells=Array.from({length:count},(_,c)=>{
          if(repeat)return null;const cell=makeStruct(row.header?'TH':'TD',tr);const id=`table-${s.dictionary.id}-r${index}-c${c}`;
          cell.dictionary.data.ID=new String(id);
          cell.dictionary.data.A={O:'Table',...(row.header?{Scope:'Column'}:headerIds[c]?{Headers:[new String(headerIds[c])]}:{})};if(row.header)headerIds[c]=id;return cell;
        });
        let offset=0;
        while(offset<full){
          if(y+lh+12>endY()){newPage();if(!row.header)for(const h of headerRows)renderRow(h,0,true);}
          if(offset){ensure(42);plain(`Row ${index+1} continued`,9.5);}
          const take=Math.min(full-offset,Math.max(1,Math.floor((endY()-y-12)/lh))),height=take*lh+12;
          doc.markContent('Artifact',{type:'Layout'});doc.save().lineWidth(0.5).strokeColor('#6b747b');
          if(row.header)doc.rect(x,y,w,height).fill('#eeeeee');doc.rect(x,y,w,height).stroke();for(let c=1;c<count;c++)doc.moveTo(x+labelW+c*cw,y).lineTo(x+labelW+c*cw,y+height).stroke();doc.restore();doc.endMarkedContent();
          if(wide)drawLine(fragments({text:String(index+1)},9.5),x+4,y+6,9.5,tr??s,repeat);
          for(let c=0;c<count;c++)for(let j=0;j<take;j++){const line=cellLines[c][offset+j];if(line)drawLine(line,x+labelW+c*cw+6,y+6+j*lh,10,cells[c],repeat);}
          y+=height;offset+=take;
        }
      };
      block.rows.forEach((row,i)=>renderRow(row,i));y+=10;
    }
  }
  function figure(b:Extract<Block,{type:'figure'}>){
    const dest=`figure-${currentItem}-${b.id}`;
    const caption=`${currentItem} / ${b.id} · ${b.title}`,figureHeight=b.svg?Math.min(b.height!*Math.max(0.75,9/b.minFont!),endY()-top-100):30;
    const captionHeight=(lines([{text:caption}],10,pageWidth()).length+lines([{text:b.alt}],10,pageWidth()).length)*14+30;
    ensure(Math.min(endY()-top,captionHeight+figureHeight+12));anchor(dest);plain(caption,10,'H3');plain(b.alt,10);
    if(!b.svg||b.error){plain(`Rendering warning: ${b.error??'Figure unavailable'}. Complete diagram source follows.`,10);paragraph([{text:b.source,code:true}],9.5,'Code',true);return;}
    const sw=b.width!,sh=b.height!,scale=Math.max(0.75,9/b.minFont!),maxH=endY()-top-100,w=pageWidth();
    const svg=preparedFigures.get(b)!;
    const paint=(px:number,py:number,ww:number,hh:number,offsetX=0,offsetY=0,zoom=scale,artifact=false)=>{
      const s=artifact?null:makeStruct('Figure',parent,{alt:`${b.title}. ${b.alt}`,bbox:[px,py,px+ww,py+hh]});
      if(s)s.add(doc.markStructureContent('Figure'));else doc.markContent('Artifact',{type:'Layout'});
      doc.save().rect(px,py,ww,hh).clip();
      SVGtoPDF(doc,svg,px-offsetX,py-offsetY,{...svgOptions,width:sw*zoom,height:sh*zoom});
      doc.restore();doc.endMarkedContent();
    };
    if(sw*scale<=w&&sh*scale<=maxH){ensure(sh*scale+8);paint(margin,y,sw*scale,sh*scale);y+=sh*scale+12;return;}
    const overlap=28,tileW=w,tileH=maxH,cols=Math.max(1,Math.ceil((sw*scale-overlap)/(tileW-overlap))),rows=Math.max(1,Math.ceil((sh*scale-overlap)/(tileH-overlap)));
    if(cols*rows>100)throw Error(`Diagram ${currentItem}/${b.id} exceeds 100 readable detail pages. Use its source export.`);
    const overview=Math.min(w/sw,200/sh);ensure(sh*overview+55);plain(`Figure overview · ${rows} rows × ${cols} columns. Read labels on the linked detail pages. Adjacent details overlap.`,9.5);paint(margin,y,sw*overview,sh*overview,0,0,overview,true);y+=sh*overview+10;
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++)paragraph([{text:`Detail ${r*cols+c+1} · row ${r+1}, column ${c+1}`,href:`#${dest}-${r}-${c}`}],9.5);
    for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
      newPage();anchor(`${dest}-${r}-${c}`);plain(`${currentItem} / ${b.id} · Detail ${r*cols+c+1} of ${rows*cols}`,11,'H3');
      paragraph([{text:`Row ${r+1}/${rows}, column ${c+1}/${cols} · `},{text:'Back to overview',href:`#${dest}`},...(c+1<cols?[{text:' · Continue right',href:`#${dest}-${r}-${c+1}`}]:[]),...(r+1<rows?[{text:' · Continue below',href:`#${dest}-${r+1}-${c}`}]:[])],9.5);
      const ox=c*(tileW-overlap),oy=r*(tileH-overlap),ww=Math.min(tileW,sw*scale-ox),hh=Math.min(tileH,sh*scale-oy);paint(margin,y,ww,hh,ox,oy);y+=hh+10;
    }
  }
  function render(blocks:Block[],x=margin,w=pageWidth()){
    for(const b of blocks){
      if(b.type==='text'){if(b.anchor){ensure(65);anchor(b.anchor);}paragraph(b.runs,b.size??11,b.role??'P',b.literal,x,w);}
      else if(b.type==='table')table(b,x,w);
      else if(b.type==='figure')figure(b);
      else {const saved=parent,list=makeStruct('L');list.dictionary.data.A={O:'List',ListNumbering:b.ordered?'Decimal':'Disc'};
        for(let i=0;i<b.items.length;i++){ensure(38);const li=makeStruct('LI',list),label=makeStruct('Lbl',li);drawLine(fragments({text:b.ordered?`${b.start+i}.`:'•'},11),x,y,11,label);parent=makeStruct('LBody',li);render(b.items[i],x+24,w-24);parent=saved;}}
    }
  }
  function reference(id:string,extra=''):Run[]{const target=source.requirements.find(r=>r.id===id);return [{text:target?`${id} · ${target.title} · r${target.revision}${extra}`:`${id} · Unavailable in this context${extra}`,...(target?{href:`#item-${id}`}:{})}];}
  try{
    // Settle conversion failures before front matter is written. A failed
    // figure becomes a complete source fallback, never a partial drawing.
    const probe:any=new PDFDocument({compress:false});probe.on('data',()=>{});
    for(const [name,data] of Object.entries(fonts))probe.registerFont(name,data);
    for(const item of model.items)for(const b of item.blocks)if(b.type==='figure'&&b.svg&&!b.error){
      try{
        const scale=Math.max(0.75,9/b.minFont!),w=(source.paper==='A4'?595.28:612)-margin*2,h=(source.paper==='A4'?841.89:792)-bottom-top-100;
        if(Math.max(1,Math.ceil((b.width!*scale-28)/(w-28)))*Math.max(1,Math.ceil((b.height!*scale-28)/(h-28)))>100)throw Error('Diagram exceeds the 100-detail-page limit.');
        const svg=figureSvg(b);SVGtoPDF(probe,svg,0,0,{...svgOptions,width:500,height:500});preparedFigures.set(b,svg);
      }catch(error){b.error=error instanceof Error?error.message:'PDF vector rendering failed.';b.svg=undefined;model.warnings.push(`${item.requirement.id} / ${b.id}: ${b.error} Complete source is included.`);}
    }
    probe.destroy();
    newPage();parent=makeStruct('Sect',root);y=116;
    paragraph([{text:source.projectName,bold:true}],28,'H1');plain('Product specification',22,'H2');plain(source.context,12);plain(`Requirement set: ${source.version===undefined?'Unknown':`v${source.version}`}`,11);
    if(source.snapshot){plain(`Snapshot name: ${source.snapshot.name}`);plain(`Snapshot created: ${source.snapshot.date||'Unknown'}`);plain('Historical project name: Unknown. The title uses the current project name as a label only.',10);plain('Status labels are values saved in this snapshot. Current lifecycle and implementation references are excluded.',10);}
    else plain(`Captured workspace version: ${source.workspaceVersion}`);
    plain(`Generated: ${source.generated} (UTC)`,10);plain(`Paper: ${source.paper==='LETTER'?'US Letter':'A4'} · Document language: English (en, default)`,10);
    plain(`${source.requirements.length} saved items · ${source.sections.length} sections. Complete saved specification; pending proposals and unsaved input are excluded.`,11);
    plain('Lifecycle status is separate from verification. This export makes no claim that tests passed.',10);
    if(model.warnings.length){plain('Rendering notices',16,'H2');for(const warning of model.warnings)plain(warning,10);}
    newPage();parent=makeStruct('TOC',root);plain('Contents',22,'H1');
    const toc:{id:string;title:string;p:number;y:number;lines:Line[]}[]=[];
    for(const section of source.sections){const title=`${section.title}${source.requirements.some(r=>r.section===section.id)?'':' · Empty section'}`,ls=lines([{text:title}],11,pageWidth()-45);ensure(ls.length*15.4+10);toc.push({id:section.id,title,p:page-1,y,lines:ls});y+=ls.length*15.4+10;}
    const tocParent=parent;
    const itemsBySection=new Map(source.sections.map(s=>[s.id,model.items.filter(i=>i.requirement.section===s.id)]));
    if(model.items.some(i=>!itemsBySection.has(i.requirement.section)))throw Error('An item references an unavailable section. Restore its section or use JSON export; no partial PDF was created.');
    for(const section of source.sections){
      currentItem='';newPage();parent=makeStruct('Sect',root);sectionPages.set(section.id,page);anchor(`section-${section.id}`);const outline=doc.outline.addItem(section.title,{expanded:false});
      paragraph([{text:section.title,bold:true}],20,'H1');if(section.description)plain(section.description);const items=itemsBySection.get(section.id)!;if(!items.length)plain('Empty section.');
      for(const {requirement:r,blocks:body} of items){
        progress(`Laying out ${r.id}`);ensure(120);currentItem=r.id;pageItems[page-1] ||= r.id;
        anchor(`item-${r.id}`);outline.addItem(`${r.id} · ${r.title}`);const saved=parent;parent=makeStruct('Sect',saved);
        paragraph([{text:`${r.id} · ${r.title}`,bold:true}],15,'H2');
        plain(`Revision ${r.revision} · ${r.kind==='information'?'Information (non-normative)':'Requirement'} · Priority: ${r.priority} · ${source.snapshot?'Status saved in snapshot':'Status'}: ${r.status}`,9.5);
        render(body);
        if(r.criteria.length){plain('Acceptance criteria',12,'H3');render([{type:'list',ordered:true,start:1,items:r.criteria.map(c=>[textBlock(c)])}]);}
        if(Object.keys(r.parameters).length){plain('Parameters',12,'H3');table({type:'table',rows:[{header:true,cells:[[textBlock('Parameter')],[textBlock('Value')]]},...Object.entries(r.parameters).map(([k,v])=>({header:false,cells:[[textBlock(k)],[textBlock(String(v))]]}))]});}
        if(r.links.length){plain('Dependencies',12,'H3');for(const id of r.links)paragraph(reference(id));}
        const tags=normalizeTags(r.tags??[]);if(tags.length)plain('Tags: '+tags.join(', '),10);
        if(r.summarizes?.length){plain('Sources',12,'H3');for(const s of r.summarizes){const target=source.requirements.find(t=>t.id===s.requirement_id),state=!target||s.reviewed_revision===undefined?'Unknown':target.revision===s.reviewed_revision?'Current review marker':'Needs review';paragraph(reference(s.requirement_id,` · Reviewed revision: ${s.reviewed_revision??'Unknown'} · ${state}`),10);}}
        if(r.diagram_mappings?.length){plain('Figure references',12,'H3');for(const m of r.diagram_mappings){paragraph([{text:`Figure ${m.block_id} · ${m.part}`,href:`#figure-${r.id}-${m.block_id}`}],10);for(const id of m.requirement_ids)paragraph(reference(id),10);}}
        y+=12;parent=saved;
      }
    }
    for(const row of toc){doc.switchToPage(row.p);const entry=makeStruct('TOCI',tocParent);row.lines.forEach((line,i)=>drawLine(line.map(f=>({...f,href:`#section-${row.id}`})),margin,row.y+i*15.4,11,entry));drawLine(fragments({text:String(sectionPages.get(row.id)),href:`#section-${row.id}`},11),doc.page.width-margin-30,row.y,11,entry);}
    const total=doc.bufferedPageRange().count;
    for(let p=0;p<total;p++){
      doc.switchToPage(p);const head=lines([{text:`${source.projectName} · ${source.snapshot?`Snapshot ${source.snapshot.id}`:`Accepted v${source.version??'Unknown'}`}`}],9,pageWidth());
      head.forEach((line,i)=>drawLine(line,margin,margin+i*12,9,null,true));
      drawLine(fragments({text:`Page ${p+1} of ${total}${pageItems[p]?` · ${pageItems[p]}`:''}`},9),margin,doc.page.height-margin-12,9,null,true);
    }
    doc.end();return await result;
  }catch(error){doc.destroy();throw error;}
}
