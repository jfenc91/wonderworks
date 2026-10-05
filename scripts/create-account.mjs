import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {passwordHash,tokenHash} from '../server/auth.mjs';
const [file,id,email]=process.argv.slice(2);
if(!file||!/^[\w@.-]{1,120}$/.test(id??'')||!email)throw Error('Usage: npm run account -- /private/accounts.json account email < /private/password-file');
// Secret input through stdin, never argv or normal logs. The API token is saved
// once to a separate private file; the account file stores only its digest.
let password='';for await(const chunk of process.stdin){password+=chunk;if(password.length>1024)throw Error('Password too long');}
password=password.trimEnd();if(password.length<12)throw Error('Use a password of at least 12 characters on stdin.');
let data={users:[]};try{data=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(data.users.some(u=>u.id===id))throw Error('Account exists. Use documented rotation/revocation instructions.');
const token=randomBytes(32).toString('base64url');data.users.push({id,email,allowed:true,password:passwordHash(password),tokens:[tokenHash(token)]});
await mkdir(dirname(resolve(file)),{recursive:true,mode:0o700});
await writeFile(file,JSON.stringify(data,null,2)+'\n',{mode:0o600});
await writeFile(file+'.'+id+'.token',token+'\n',{mode:0o600,flag:'wx'});
console.log('Account provisioned. API token saved in the adjacent private .token file.');
