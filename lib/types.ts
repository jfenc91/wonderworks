export type Requirement = { id:string; section:string; title:string; description:string; criteria:string[]; priority:'Critical'|'High'|'Medium'; status:'Draft'|'Approved'|'Implemented'; revision:number; parameters:Record<string,number|string|boolean>; links:string[] };
export type Section = {id:string; title:string; description:string};
export type Repository = {id:string;name:string;url:string;branch:string};
export type Baseline = {id:string;date:string;name:string;requirements:Requirement[];sections:Section[];requirementsVersion?:number;repositories?:Repository[]};
export type ChangeProposal = {id:string;title:string;description:string;status:'Draft'|'Proposed'|'Applied'|'Rejected';createdAt:string;updatedAt:string;baseVersion:number;baseRequirements:Requirement[];baseSections:Section[];requirements:Requirement[];reviewNote?:string;appliedVersion?:number;appliedSnapshot?:string};
export type Evidence = {id:string;date:string;baseline:string;artifactUrl:string;summary:string;checks:{id:string;title:string;passed:boolean;detail:string}[]};
export type Activity = {id:string;date:string;message:string;mcp?:{actorId:string;clientName?:string;tool:string;projectId:string;objectIds:string[];correlationId:string}};
export type Workspace = {id:string;prefix:string;name:string;sections:Section[];requirements:Requirement[];history:Activity[];baselines:Baseline[];evidence:Evidence[];version:number;nextSequence?:number;requirementsVersion?:number;repositories?:Repository[];proposals?:ChangeProposal[]};
