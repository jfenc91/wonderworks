import {AsyncLocalStorage} from 'node:async_hooks';
type Runtime={db:D1Database;config:{profile:string;auth:string;baseUrl:string|null}};
const contexts=new AsyncLocalStorage<Runtime>();
function runtime(){const value=contexts.getStore()??(globalThis as typeof globalThis&{__wonderworksRuntime?:Runtime}).__wonderworksRuntime;if(!value)throw Error('Database runtime is unavailable. Start a supported deployment profile.');return value;}
export function database(){return runtime().db;}
export function deployment(){const {profile,auth,baseUrl}=runtime().config;return {profile,auth,baseUrl};}
export function runWithDatabase<T>(db:D1Database,callback:()=>T){return contexts.run({db,config:{profile:'sites',auth:'Sites managed OAuth',baseUrl:null}},callback);}
