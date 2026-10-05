import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,chmod,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname} from 'node:path';
import pg from 'pg';

// Deliberately narrow D1-compatible parameterized SQL surface. Each batch is
// one transaction on one connection. PostgreSQL serializes publication batches
// across processes, so conditional receipt INSERT and workspace CAS see the
// same version (READ COMMITTED alone would allow a losing receipt to commit).
const lockId=1465336651;
function storageError(error){const value=new Error('Database operation failed. Check availability, schema and disk capacity; retry after recovery.');value.retryable=true;value.code=/^[A-Z0-9_]{3,40}$/.test(error?.code??'')?error.code:'STORAGE_UNAVAILABLE';return value;}
export function postgresSql(sql){
  let n=0;const ignore=/^\s*INSERT OR IGNORE\b/i.test(sql);
  return sql.replace(/INSERT OR IGNORE/i,'INSERT').replace(/`/g,'"').replace(/\?/g,()=>'$'+(++n))+(ignore?' ON CONFLICT DO NOTHING':'');
}
function statement(owner,sql,args=[]){return {sql,args,bind(...values){return statement(owner,sql,values);},async all(){return (await owner.batch([this]))[0];},async first(column){const row=(await this.all()).results[0]??null;return column&&row?row[column]:row;},async run(){return this.all();}};}
export async function openDatabase(config,{create=false}={}){
  if(config.profile==='local'){
    if(create)await mkdir(dirname(config.sqlitePath),{recursive:true,mode:0o700});
    else await access(config.sqlitePath,constants.R_OK|constants.W_OK);
    await access(dirname(config.sqlitePath),constants.R_OK|constants.W_OK);
    const db=new DatabaseSync(config.sqlitePath,{open:true,timeout:2000});
    await chmod(config.sqlitePath,0o600);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;');
    const owner={kind:'sqlite',prepare(sql){return statement(owner,sql);},async batch(statements){
      try{
        db.exec('BEGIN IMMEDIATE');
        const results=statements.map(({sql,args})=>{const s=db.prepare(sql);if(s.columns().length){return {results:s.all(...args),success:true,meta:{changes:0}};}const r=s.run(...args);return {results:[],success:true,meta:{changes:Number(r.changes)}};});
        db.exec('COMMIT');return results;
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw storageError(error);}
    },async exec(sql){try{db.exec(sql);}catch(error){throw storageError(error);}},async close(){db.close();}};
    return owner;
  }
  const ssl=config.tls==='disable'?false:{rejectUnauthorized:true,...(config.caFile?{ca:await readFile(config.caFile,'utf8')}:{})};
  const pool=new pg.Pool({connectionString:config.databaseUrl,ssl,max:8,connectionTimeoutMillis:5000,statement_timeout:15000,idle_in_transaction_session_timeout:30000});
  pool.on('error',()=>console.error(JSON.stringify({event:'database_connection_failure',backend:'postgres'})));
  const owner={kind:'postgres',prepare(sql){return statement(owner,sql);},async batch(statements){
    let client;try{client=await pool.connect();}catch(error){throw storageError(error);}
    try{
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      // Reads also capture one coherent installation state for archives.
      await client.query('SELECT pg_advisory_xact_lock($1)',[lockId]);
      const results=[];for(const {sql,args} of statements){const r=await client.query(postgresSql(sql),args);results.push({results:r.rows,success:true,meta:{changes:r.command==='SELECT'?0:r.rowCount??0}});}
      await client.query('COMMIT');return results;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw storageError(error);}finally{client.release();}
  },async exec(sql){let client;try{client=await pool.connect();await client.query(sql);}catch(error){throw storageError(error);}finally{client?.release();}},async close(){await pool.end();}};
  return owner;
}

export const SCHEMA_VERSION=4;
export async function migrate(db){
  // DDL and migration marker commit together; advisory/SQLite write locks also
  // serialize competing installers. Existing v0–v3 tables are upgraded in place.
  await db.prepare('CREATE TABLE IF NOT EXISTS wonderworks_schema(version INTEGER PRIMARY KEY)').run();
  const current=await db.prepare('SELECT version FROM wonderworks_schema ORDER BY version DESC').first();
  if(current&&current.version>SCHEMA_VERSION)throw Error('Database schema is newer than this application. Use the matching release.');
  const b=db.kind==='postgres'?'BIGINT':'INTEGER';
  const schema=[
    'CREATE TABLE IF NOT EXISTS wonderworks_schema(version INTEGER PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0)',
    `CREATE TABLE IF NOT EXISTS mcp_receipts(key TEXT PRIMARY KEY,project TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,expires_at ${b} NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS mcp_receipts_expiry ON mcp_receipts(expires_at)',
    `CREATE TABLE IF NOT EXISTS workspace_records(project TEXT NOT NULL,hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project,hash),CHECK(${db.kind==='postgres'?'octet_length(data)':'length(CAST(data AS BLOB))'}<=65536))`,
    'CREATE TABLE IF NOT EXISTS workspace_storage_versions(project TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,sha256 TEXT NOT NULL,legacy_data TEXT,created_at TEXT NOT NULL,PRIMARY KEY(project,version))',
    'CREATE TABLE IF NOT EXISTS workspace_imports(key TEXT PRIMARY KEY,actor TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS workspace_provenance(project TEXT PRIMARY KEY,data TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS auth_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at ${b} NOT NULL)`,
  ];
  await db.batch([...schema.map(sql=>db.prepare(sql)),db.prepare('INSERT OR IGNORE INTO wonderworks_schema(version) VALUES(?)').bind(SCHEMA_VERSION)]);
  await readiness(db);
}
export async function readiness(db){
  const result=await db.batch([
    db.prepare('SELECT version FROM wonderworks_schema ORDER BY version DESC'),
    db.prepare('SELECT id,data,version FROM workspaces LIMIT 0'),db.prepare('SELECT key,project,fingerprint,result,expires_at FROM mcp_receipts LIMIT 0'),
    db.prepare('SELECT project,hash,data FROM workspace_records LIMIT 0'),db.prepare('SELECT project,version,data,sha256,legacy_data,created_at FROM workspace_storage_versions LIMIT 0'),
    db.prepare('SELECT key,actor,fingerprint,result,created_at FROM workspace_imports LIMIT 0'),db.prepare('SELECT project,data FROM workspace_provenance LIMIT 0'),db.prepare('SELECT id,user_id,expires_at FROM auth_sessions LIMIT 0')
  ]);
  if(result[0].results[0]?.version!==SCHEMA_VERSION)throw Error('Database schema is incompatible. Back up, then run npm run setup.');
}
