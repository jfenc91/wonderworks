import {createBuilder} from 'vite';
import {writeFile} from 'node:fs/promises';
// The vinext CLI ignores --config. Use Vite's supported multi-environment
// builder explicitly so a standalone build never loads the Sites config.
process.env.NODE_ENV='production';
const builder=await createBuilder({configFile:'vite.standalone.config.ts'});
await builder.buildApp();
await writeFile('dist/wonderworks-profile.json',JSON.stringify({profile:'standalone',version:'0.2.0'}));
