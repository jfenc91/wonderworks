import {configuration} from '../server/config.mjs';
import {openDatabase,migrate,SCHEMA_VERSION} from '../server/database.mjs';
const config=configuration();let db;
try{db=await openDatabase(config,{create:true});await migrate(db);console.log(JSON.stringify({profile:config.profile,schema:SCHEMA_VERSION,status:'ready',...(config.profile==='local'?{path:config.sqlitePath}:{})}));}
catch{console.error('Database setup failed. Check the configured database, filesystem permissions, and migration compatibility. No fallback database was used.');process.exitCode=1;}
finally{await db?.close();}
