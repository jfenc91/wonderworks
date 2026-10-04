import {normative} from './item-content';
import {z} from 'zod';
import type {Workspace} from './types';
import {record} from './requirements';

export const evidenceInput=z.object({
  baseline:z.string(),
  artifactUrl:z.string().url().refine(s=>['https:','http:'].includes(new URL(s).protocol)),
  summary:z.string().min(10).max(3000),
  checks:z.array(z.object({id:z.string(),title:z.string(),passed:z.boolean(),detail:z.string()})).min(1).max(150)
});

export function recordEvidence(doc:Workspace,input:unknown){
  const evidence=evidenceInput.parse(input);
  const baseline=doc.baselines.find(b=>b.id===evidence.baseline);
  if(!baseline)throw Error('Baseline not found');
  if(evidence.checks.some(c=>!baseline.requirements.some(r=>r.id===c.id&&normative(r))))throw Error('Every result must reference a requirement in its baseline');
  const saved={...evidence,id:crypto.randomUUID(),date:new Date().toISOString()};
  doc.evidence.unshift(saved);
  record(doc,`Verification recorded for ${evidence.baseline} · ${evidence.checks.filter(c=>c.passed).length}/${evidence.checks.length} passed`);
  return saved;
}
