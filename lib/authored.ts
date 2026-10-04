import type {Requirement} from './types';
import {tagsOf} from './tags';
export const authoredFields=['section','title','description','criteria','priority','parameters','links','tags','kind','body_format','diagrams','summarizes','diagram_mappings'] as const;
export const requirementFields=[...authoredFields,'status'] as const;
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value)??'undefined';
}
export function authored(r:Requirement){return Object.fromEntries(authoredFields.map(f=>[f,f==='tags'?tagsOf(r):r[f]]));}
export function sameRequirement(a?:Requirement,b?:Requirement){return !a||!b?a===b:canonical(authored(a))===canonical(authored(b));}
export function exactRevision(a:Requirement,b:Requirement){return a.id===b.id&&a.revision===b.revision&&sameRequirement(a,b);}
