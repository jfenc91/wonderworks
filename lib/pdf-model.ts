import type {Requirement, Section, Workspace} from './types';

export const PDF_LIMITS = {milliseconds:120_000, inputBytes:20_000_000, items:2000, diagrams:200, pages:1500, outputBytes:64_000_000};
export type Paper = 'A4'|'LETTER';
export type PdfSource = {
  projectId:string; projectName:string; context:string; snapshot?:{id:string;name:string;date:string};
  version?:number; workspaceVersion?:number; generated:string; paper:Paper; language:'en';
  requirements:Requirement[]; sections:Section[]; filename:string;
};
export type Run = {text:string;bold?:boolean;italic?:boolean;code?:boolean;href?:string};
export type Block =
  | {type:'text';runs:Run[];role?:string;size?:number;literal?:boolean;anchor?:string}
  | {type:'list';ordered:boolean;start:number;items:Block[][]}
  | {type:'table';rows:{header:boolean;cells:Block[][]}[];caption?:string}
  | {type:'figure';id:string;title:string;alt:string;source:string;svg?:string;error?:string;width?:number;height?:number;minFont?:number};
export type PdfItem = {requirement:Requirement;blocks:Block[]};
export type PdfModel = {source:PdfSource;items:PdfItem[];warnings:string[]};

/** Capture only the authorized committed read, never the filtered/staged screen. */
export function capturePdfSource(doc:Workspace, paper:Paper, snapshotId?:string):PdfSource {
  const saved=snapshotId?doc.baselines.find(b=>b.id===snapshotId):undefined;
  if(snapshotId&&!saved)throw Error('The selected snapshot is unavailable. Refresh and select it again.');
  const requirements=saved?.requirements??doc.requirements;
  if(!requirements.length)throw Error('This specification is empty. Add saved items before downloading a PDF.');
  if(requirements.length>PDF_LIMITS.items)throw Error(`PDF export supports ${PDF_LIMITS.items} items. Use the existing source export for this specification.`);
  const version=saved?saved.requirementsVersion:doc.requirementsVersion;
  const context=saved?`Snapshot ${saved.id}`:`Latest accepted · set ${version===undefined?'Unknown':`v${version}`} · workspace v${doc.version}`;
  const safe=doc.name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,80)||'specification';
  const source:PdfSource={projectId:doc.id,projectName:doc.name,context,version,...(!saved?{workspaceVersion:doc.version}:{snapshot:{id:saved.id,name:saved.name,date:saved.date}}),generated:new Date().toISOString(),paper,language:'en',requirements,sections:saved?.sections??doc.sections,filename:`${safe}-${saved?saved.id.replace(/[^\w-]/g,'-'):`accepted-v${version??'unknown'}`}.pdf`};
  if(new TextEncoder().encode(JSON.stringify(source)).length>PDF_LIMITS.inputBytes)throw Error('PDF input exceeds 20 MB. Use the existing Markdown or JSON export.');
  return structuredClone(source);
}

export function safePdfLink(href:string):string|undefined {
  try {const u=new URL(href);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:undefined;} catch {return undefined;}
}
