import {upsert} from '../../lib/requirements.ts';
import {captureRequirementHistory} from '../../lib/requirement-history.ts';
import {createProposal,editProposalRequirement,deleteProposalRequirement,submitProposal,reviewProposal,snapshot} from '../../lib/workflow.ts';
export const input=(extra={})=>({section:'section',title:'Snapshot requirement',description:'The system shall retain exact implementation context.',criteria:['The saved context remains readable.'],priority:'High',status:'Draft',parameters:{},links:[],...extra});
export function workspace(id='snapshot-test'){
  const doc={id,prefix:'SI',name:'Snapshot association QA',version:0,requirementsVersion:1,sections:[{id:'section',title:'Behavior',description:''}],requirements:[],baselines:[],evidence:[],history:[],proposals:[],repositories:[{id:'repo',name:'Implementation',url:'https://example.com/project',branch:'main'}]};
  const before=structuredClone(doc);upsert(doc,input());upsert(doc,input({title:'Removed by proposal'}));captureRequirementHistory(before,doc,{source:'requirements',actor:{id:'author'}});
  snapshot(doc,'Original frozen snapshot');
  doc.evidence.push({id:'existing-evidence',date:'2026-10-01T00:00:00.000Z',baseline:'BL-001',artifactUrl:'https://example.com/verification',summary:'Existing baseline-specific verification.',checks:[{id:'SI-001',title:'Historical result',passed:false,detail:'Keep the original outcome.'}]});
  const p=createProposal(doc,{title:'Add edit and delete together'});
  editProposalRequirement(doc,p.id,{...input({title:'Accepted change'}),id:'SI-001'});
  deleteProposalRequirement(doc,p.id,'SI-002');editProposalRequirement(doc,p.id,input({title:'New proposed identity'}));
  return doc;
}
export function apply(doc){const before=structuredClone(doc),p=doc.proposals[0];submitProposal(doc,p.id);reviewProposal(doc,p.id,{decision:'apply',note:'Accepted exact batch'});captureRequirementHistory(before,doc,{source:'proposal_review',actor:{id:'reviewer'}});return p;}
export const frozen=doc=>JSON.stringify({requirements:doc.requirements,sections:doc.sections,baselines:doc.baselines,proposals:doc.proposals,evidence:doc.evidence,requirementHistory:doc.requirementHistory,requirementsVersion:doc.requirementsVersion});
