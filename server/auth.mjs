import {createHash,createHmac,scryptSync,timingSafeEqual,randomBytes} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function passwordHash(password,salt=randomBytes(16).toString('hex')){return `scrypt:${salt}:${scryptSync(password,salt,32).toString('hex')}`;}
export function tokenHash(token){return hash(token);}
export async function accounts(config){
  const file=await stat(config.accountsFile);
  if((file.mode&0o077)!==0)throw Error('WW_ACCOUNTS_FILE must be private (chmod 600).');
  const data=JSON.parse(await readFile(config.accountsFile,'utf8'));
  if(!Array.isArray(data.users)||!data.users.length||data.users.length>100||new Set(data.users.map(u=>u.id)).size!==data.users.length)throw Error('WW_ACCOUNTS_FILE requires unique users.');
  for(const u of data.users)if(!/^[\w@.-]{1,120}$/.test(u.id)||typeof u.email!=='string'||u.email.length>200||typeof u.allowed!=='boolean'||!/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(u.password)||!Array.isArray(u.tokens)||u.tokens.some(t=>!/^[a-f0-9]{64}$/.test(t)))throw Error('WW_ACCOUNTS_FILE has an invalid user record.');
  return data.users;
}
function signature(config,payload){return createHmac('sha256',config.sessionSecret).update(payload).digest('base64url');}
export async function authenticate(config,request,remote,db){
  if(config.auth==='local'){
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||new URL(request.url).origin!==config.baseUrl)return {status:403};
    return {user:{id:'local-user',email:'local@wonderworks.invalid',allowed:true}};
  }
  const users=await accounts(config),authorization=request.headers.get('authorization');let user;
  if(authorization){const token=authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];if(token)user=users.find(u=>u.tokens.some(t=>equal(t,hash(token))));}
  else {
    const cookies=(request.headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('ww_session='));
    if(cookies.length===1){const value=cookies[0].slice(11),[payload,mac]=value.split('.');
      if(payload?.length<2000&&equal(mac,signature(config,payload))){
        let data;try{data=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{}
        if(data?.expires>Date.now()){
          const candidate=users.find(u=>u.id===data.id);
          const live=db&&await db.prepare('SELECT user_id FROM auth_sessions WHERE id=? AND expires_at>?').bind(hash(payload),Date.now()).first();
          if(candidate&&live?.user_id===candidate.id&&equal(data.revision,hash(candidate.password)))user=candidate;
        }
      }
    }
  }
  return user?user.allowed?{user}:{status:403}:{status:401};
}
const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attempts=new Map();
export async function authRoute(config,request,remote,db){
  const url=new URL(request.url),logout=url.pathname==='/signout-with-chatgpt';
  if(!['/signin-with-chatgpt','/signout-with-chatgpt','/login'].includes(url.pathname))return null;
  const origin=request.headers.get('origin');
  if((origin&&origin!==config.baseUrl)||request.headers.get('sec-fetch-site')==='cross-site')return new Response('Origin rejected',{status:403});
  const headers={'Cache-Control':'no-store','Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
  if(config.auth==='local')return new Response(null,{status:303,headers:{Location:'/'}});
  const secure=config.baseUrl.startsWith('https:')?'; Secure':'';
  if(logout){
    if(request.method!=='POST')return new Response('<form method="post"><button>Sign out</button></form>',{headers});
    const value=(request.headers.get('cookie')??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('ww_session='))?.slice(11),payload=value?.split('.')[0],mac=value?.split('.')[1];
    if(db&&payload&&equal(mac,signature(config,payload)))await db.prepare('DELETE FROM auth_sessions WHERE id=?').bind(hash(payload)).run();
    return new Response(null,{status:303,headers:{Location:'/login','Set-Cookie':`ww_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,'Cache-Control':'no-store'}});
  }
  let error='';
  if(request.method==='POST'){
    const now=Date.now(),key=remote;for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);
    const count=attempts.get(key)??{count:0,until:now+60000};
    if(count.count>=10||attempts.size>10000)return new Response('Try again in one minute.',{status:429,headers:{'Retry-After':'60'}});
    count.count++;attempts.set(key,count);
    if(Number(request.headers.get('content-length'))>4096)return new Response('Request too large',{status:413});
    const reader=request.body?.getReader();let text='';if(reader)while(true){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);if(text.length>4096){await reader.cancel();return new Response('Request too large',{status:413});}}
    const input=new URLSearchParams(text),users=await accounts(config),user=users.find(u=>u.id===input.get('id'));
    const salt=user?.password.split(':')[1]??'0'.repeat(32),candidate=passwordHash(input.get('password')??'',salt);
    if(user&&equal(candidate,user.password)){
      if(!user.allowed)return new Response('Access denied',{status:403});
      if(!db)throw Error('Authentication session storage unavailable.');
      attempts.delete(key);const payload=Buffer.from(JSON.stringify({id:user.id,revision:hash(user.password),nonce:randomBytes(16).toString('hex'),expires:now+8*3600000})).toString('base64url');
      await db.batch([db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').bind(now),db.prepare('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES(?,?,?)').bind(hash(payload),user.id,now+8*3600000)]);
      return new Response(null,{status:303,headers:{Location:'/','Set-Cookie':`ww_session=${payload}.${signature(config,payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`,'Cache-Control':'no-store'}});
    }
    error='Invalid account or password.';
  }else if(request.method!=='GET')return new Response('Method not allowed',{status:405});
  return new Response(`<!doctype html><html lang="en"><title>Sign in · Wonderworks</title><main><h1>Sign in to Wonderworks</h1><p>${escape(error)}</p><form method="post"><p><label>Account <input name="id" autocomplete="username" required></label></p><p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p><button>Sign in</button></form></main></html>`,{status:error?401:200,headers});
}
export function trustedRequest(request,user){
  const headers=new Headers(request.headers);
  for(const name of [...headers.keys()])if(name.startsWith('oai-')||name==='forwarded'||name.startsWith('x-forwarded-')||name.startsWith('x-ww-'))headers.delete(name);
  if(user){headers.set('oai-authenticated-user-id',user.id);headers.set('oai-authenticated-user-email',user.email);}
  return new Request(request,{headers});
}
