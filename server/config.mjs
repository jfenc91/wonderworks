import {resolve} from 'node:path';
import {homedir} from 'node:os';
export function configuration(env=process.env){
  const profile=env.WW_PROFILE??'local';
  if(!['local','self-hosted'].includes(profile))throw Error('WW_PROFILE must be local or self-hosted. Use the Sites build/publish workflow for Sites.');
  const host=env.WW_HOST??(profile==='local'?'127.0.0.1':'0.0.0.0');
  const port=Number(env.WW_PORT??3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('WW_PORT must be 1–65535.');
  const auth=env.WW_AUTH??(profile==='local'?'local':'accounts');
  if(auth!==(profile==='local'?'local':'accounts'))throw Error('WW_AUTH must be local for local, or accounts for self-hosted.');
  if(profile==='local'&&host!=='127.0.0.1'&&host!=='::1')throw Error('WW_HOST must be a loopback IP in local mode. Use self-hosted for network access.');
  const baseUrl=env.WW_PUBLIC_URL??(profile==='local'?`http://${host==='::1'?'[::1]':host}:${port}`:'');
  let url;try{url=new URL(baseUrl);}catch{throw Error('WW_PUBLIC_URL must be the externally visible HTTP(S) origin.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('WW_PUBLIC_URL must contain only a credential-free HTTP(S) origin.');
  if(profile==='local'&&(url.hostname.replace(/^\[|\]$/g,'')!==host||Number(url.port||80)!==port||url.protocol!=='http:'))throw Error('WW_PUBLIC_URL must match the local loopback listener.');
  if(profile==='self-hosted'&&url.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('WW_PUBLIC_URL requires HTTPS for shared/network access. Terminate TLS at your proxy.');
  if(env.WW_TRUST_PROXY||env.TRUST_PROXY||env.VINEXT_TRUST_PROXY)throw Error('Proxy identity/forwarded-header trust is unsupported. Use built-in accounts and preserve the configured Host.');
  const sqlitePath=resolve(env.WW_SQLITE_PATH??resolve(homedir(),'.local/share/wonderworks/workspace.sqlite'));
  if(env.WW_SQLITE_PATH===':memory:')throw Error('WW_SQLITE_PATH must be a persistent local disk path.');
  if(profile==='local'&&env.WW_DATABASE_URL)throw Error('WW_DATABASE_URL requires WW_PROFILE=self-hosted.');
  const databaseUrl=env.WW_DATABASE_URL;
  if(profile==='self-hosted'){
    let db;try{db=new URL(databaseUrl);}catch{throw Error('WW_DATABASE_URL must specify PostgreSQL.');}
    if(!['postgres:','postgresql:'].includes(db.protocol))throw Error('WW_DATABASE_URL must specify PostgreSQL.');
    if(db.search)throw Error('Use WW_PG_TLS and WW_PG_CA_FILE instead of connection URL query options.');
    if(!env.WW_ACCOUNTS_FILE||!env.WW_SESSION_SECRET||env.WW_SESSION_SECRET.length<32)throw Error('WW_ACCOUNTS_FILE and WW_SESSION_SECRET (at least 32 characters) are required.');
  }
  const tls=env.WW_PG_TLS??'verify-full';
  if(!['verify-full','disable'].includes(tls))throw Error('WW_PG_TLS must be verify-full or disable (private local database only).');
  return {profile,host,port,auth,baseUrl:url.origin,sqlitePath,databaseUrl,tls,caFile:env.WW_PG_CA_FILE,accountsFile:env.WW_ACCOUNTS_FILE,sessionSecret:env.WW_SESSION_SECRET};
}
