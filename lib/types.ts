export type Requirement = { id:string; section:string; title:string; description:string; criteria:string[]; priority:'Critical'|'High'|'Medium'; status:'Draft'|'Approved'|'Implemented'; revision:number; parameters:Record<string,number|string|boolean>; links:string[] };
export type Section = {id:string; title:string; description:string};
export type Baseline = {id:string;date:string;name:string;requirements:Requirement[];sections:Section[]};
export type Evidence = {id:string;date:string;baseline:string;artifactUrl:string;summary:string;checks:{id:string;title:string;passed:boolean;detail:string}[]};
export type Workspace = {id:string;prefix:string;name:string;sections:Section[];requirements:Requirement[];history:{id:string;date:string;message:string}[];baselines:Baseline[];evidence:Evidence[];version:number};
