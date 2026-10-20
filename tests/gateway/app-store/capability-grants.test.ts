import {describe,it,expect} from 'vitest';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {writeCommunityGrants} from '../../../packages/gateway/src/app-store/capability-grants.js';
describe.skipIf(process.platform!=='linux')('separate owner AI authorization',()=>{
 it('never enables paid AI when an install declares AI capability',async()=>{const home=await mkdtemp(join(tmpdir(),'matrix-store-ai-'));try{await mkdir(join(home,'system'),{mode:0o700});const bytes=JSON.stringify({apps:['apps/previous']});await writeFile(join(home,'system/app-ai.json'),bytes);await writeCommunityGrants(home,{appSlug:'fixture-app',capabilities:{integrations:{required:[],optional:[]},permissions:['ai'],tables:[]}} as never);expect(await readFile(join(home,'system/app-ai.json'),'utf8')).toBe(bytes);}finally{await rm(home,{recursive:true,force:true});}});
});
