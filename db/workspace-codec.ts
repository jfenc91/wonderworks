import type {Workspace} from '../lib/types';

// Older rows remain ordinary JSON. Large records use a versioned, lossless
// envelope inside the same transactional D1 cell; public objects stay unchanged.
const marker='wonderworks.workspace.gzip.v1';
const threshold=512_000;
export async function encodeStoredRecord(doc:object):Promise<string>{
 const json=JSON.stringify(doc),bytes=new TextEncoder().encode(json);
 if(bytes.length<threshold)return json;
 const stream=new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
 const packed=new Uint8Array(await new Response(stream).arrayBuffer());
 let binary='';for(let i=0;i<packed.length;i+=8192)binary+=String.fromCharCode(...packed.subarray(i,i+8192));
 return JSON.stringify({storage_encoding:marker,name:(doc as {name?:string}).name,payload:btoa(binary)});
}
export async function decodeStoredRecord<T>(data:string):Promise<T>{
 const value=JSON.parse(data);
 if(value.storage_encoding!==marker)return value as T;
 if(typeof value.payload!=='string')throw Error('Invalid compressed workspace');
 const bytes=Uint8Array.from(atob(value.payload),c=>c.charCodeAt(0));
 const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
 return JSON.parse(await new Response(stream).text()) as T;
}
export const encodeWorkspace=(doc:Workspace)=>encodeStoredRecord(doc);
export const decodeWorkspace=(data:string)=>decodeStoredRecord<Workspace>(data);
