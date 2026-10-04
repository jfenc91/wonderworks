export class ToolError extends Error {
  constructor(public code:string,message:string,public details:Record<string,unknown>={}){super(message);}
}
export class ProtocolError extends Error {
  constructor(public code:number,message:string,public status=400,public data?:unknown){super(message);}
}
