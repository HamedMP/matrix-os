import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { encodeAppBundle, decodeAppBundle, validateBundlePath } from '@matrix-os/contracts/app-store-bundle';
import { dependencyPlan, fetchDependencies } from './dependency-broker.js';
import { buildSandboxLaunch, sandboxAvailable } from './build-sandbox.js';
import { STORE_BUILD_DRIVER } from './build-driver.js';

export class StoreBuildError extends Error {
 constructor(readonly code:'unavailable'|'build_failed'|'invalid'){super('App build is unavailable');this.name='StoreBuildError';}
}
export interface LocalStoreBuilder {build(files:ReadonlyMap<string,Buffer>,signal?:AbortSignal):Promise<Map<string,Buffer>>;close():Promise<void>}
const run=promisify(execFile);
const BLOCKED_CONFIG=/(?:^|\/)(?:\.npmrc|\.pnpmfile\.(?:cjs|js)|pnpm-workspace\.yaml|\.yarnrc(?:\.yml)?)$/;
export function createLocalStoreBuilder(options:{homePath:string;nodeRoot?:string;available?:()=>boolean;fetcher?:typeof fetch}):LocalStoreBuilder {
 const active=new Set<Promise<Map<string,Buffer>>>(); // Cap two; evicted only on settlement.
 const stop=new AbortController();
 async function build(files:ReadonlyMap<string,Buffer>,signal?:AbortSignal):Promise<Map<string,Buffer>> {
  if(stop.signal.aborted||active.size>=2||!(options.available??sandboxAvailable)())throw new StoreBuildError('unavailable');
  const abort=AbortSignal.any([stop.signal,...(signal?[signal]:[]),AbortSignal.timeout(180_000)]);
  // Validate bounded paths before writing anything; no submitted command runs outside bwrap.
  try{encodeAppBundle('source',files);}catch(error:unknown){if(error instanceof Error)throw new StoreBuildError('invalid');throw error;}
  const root=join(options.homePath,'data/app-store/builds');
  await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new StoreBuildError('unavailable');
  const directory=await mkdtemp(join(root,'build-'));
  const source=join(directory,'source'),dependencies=join(directory,'deps'),driver=join(directory,'driver.mjs');
  const unit=`matrix-store-build-${randomUUID().replaceAll('-','')}`;
  let launch:ReturnType<typeof buildSandboxLaunch>|undefined;
  try{
   await mkdir(source,{mode:0o700});await mkdir(dependencies,{mode:0o700});
   const lock=files.get('pnpm-lock.yaml');if(!lock)throw new StoreBuildError('invalid');
   const plan=dependencyPlan(lock.toString('utf8'));
   await fetchDependencies(plan,dependencies,abort,options.fetcher);
   for(const [key,bytes] of files){
    if(BLOCKED_CONFIG.test(key))continue;
    validateBundlePath(key,'source');const target=join(source,key);await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,key==='pnpm-lock.yaml'?plan.lockfile:bytes,{flag:'wx',mode:0o600});
   }
   await writeFile(driver,STORE_BUILD_DRIVER,{flag:'wx',mode:0o600});
   launch=buildSandboxLaunch({source,dependencies,driver,nodeRoot:options.nodeRoot??'/opt/matrix/runtime/node',unit,uid:process.getuid!()});
   const output=await run(launch.command,launch.args,{env:launch.env,signal:abort,timeout:130_000,maxBuffer:40*1024*1024,killSignal:'SIGKILL',encoding:'utf8'});
   const entries:unknown=JSON.parse(output.stdout);
   if(!Array.isArray(entries)||entries.length>512)throw new StoreBuildError('build_failed');
   const dist=new Map<string,Buffer>();
   for(const value of entries){
    if(!value||typeof value!=='object'||typeof value.path!=='string'||typeof value.data!=='string'||value.data.length>12*1024*1024||dist.has(value.path))throw new StoreBuildError('build_failed');
    dist.set(value.path,Buffer.from(value.data,'base64'));
   }
   return decodeAppBundle(encodeAppBundle('dist',dist),{kind:'dist'}).files;
  }catch(error:unknown){
   if(error instanceof StoreBuildError)throw error;
   console.warn('[app-store] Isolated build failed',error instanceof Error?error.name:'UnknownError');
   throw new StoreBuildError('build_failed');
  }finally{
   if(launch){
    // Stop the entire service cgroup, including descendants that outlived Vite.
    try{await run('/usr/bin/systemctl',['--user','stop',`${unit}.service`],{env:launch.env,timeout:10_000,maxBuffer:16_384});}
    catch(error:unknown){console.warn('[app-store] Build service drain failed',error instanceof Error?error.name:'UnknownError');}
   }
   await rm(directory,{recursive:true,force:true});
  }
 }
 return {build(files,signal){
  const pending=build(files,signal);active.add(pending);void pending.finally(()=>active.delete(pending)).catch((error:unknown)=>{if(!(error instanceof Error))console.warn('[app-store] Build promise failed');});return pending;
 },async close(){stop.abort();await Promise.allSettled([...active]);}};
}
