import { execFile } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { encodeAppBundle, decodeAppBundle, validateBundlePath } from '@matrix-os/contracts/app-store-bundle';
import { dependencyPlan, fetchDependencies } from './dependency-broker.js';
import { buildSandboxLaunch, sandboxAvailable } from './build-sandbox.js';
import { STORE_BUILD_DRIVER } from './build-driver.js';
import {withStoreDirectory,sweepPrivateChildren} from './private-state.js';

export class StoreBuildError extends Error {
 constructor(readonly code:'unavailable'|'build_failed'|'invalid'){super('App build is unavailable');this.name='StoreBuildError';}
}
export interface StoreToolchain {nodeVersion:string;pnpmVersion:string;policyDigest:string}
export interface StoreBuildResult {files:Map<string,Buffer>;toolchain:StoreToolchain}
export type StoreBuildCommandRunner=(command:string,args:readonly string[],options:{env:NodeJS.ProcessEnv;cwd?:string;timeout:number;maxBuffer:number;signal?:AbortSignal;killSignal?:NodeJS.Signals;encoding?:'utf8'})=>Promise<{stdout:string;stderr:string}>;
export interface LocalStoreBuilder {build(files:ReadonlyMap<string,Buffer>,signal?:AbortSignal):Promise<StoreBuildResult>;close():Promise<void>}
const run=promisify(execFile);
const BLOCKED_CONFIG=/(?:^|\/)(?:\.npmrc|\.pnpmfile\.(?:cjs|js)|pnpm-workspace\.yaml|\.yarnrc(?:\.yml)?)$/;
export function createLocalStoreBuilder(options:{homePath:string;nodeRoot?:string;available?:()=>boolean;fetcher?:typeof fetch;runCommand?:StoreBuildCommandRunner}):LocalStoreBuilder {
 const execute:StoreBuildCommandRunner=options.runCommand??(async(command,args,settings)=>{const result=await run(command,args,settings);return {stdout:String(result.stdout),stderr:String(result.stderr)};});
 const active=new Set<Promise<StoreBuildResult>>(); // Cap two; evicted only on settlement.
 const stop=new AbortController();
 const sweep=()=>withStoreDirectory(options.homePath,['builds'],dir=>sweepPrivateChildren(dir,/^build-[A-Za-z0-9]+$/,3600_000,32));
 const timer=setInterval(()=>{if((options.available??sandboxAvailable)())void sweep().catch((error:unknown)=>console.warn('[app-store] Build cleanup unavailable',error instanceof Error?error.name:'UnknownError'));},3600_000);timer.unref();
 async function build(files:ReadonlyMap<string,Buffer>,signal?:AbortSignal):Promise<StoreBuildResult> {
  if(stop.signal.aborted||active.size>=2||!(options.available??sandboxAvailable)())throw new StoreBuildError('unavailable');
  const abort=AbortSignal.any([stop.signal,...(signal?[signal]:[]),AbortSignal.timeout(180_000)]);
  // Validate bounded paths before writing anything; no submitted command runs outside bwrap.
  try{encodeAppBundle('source',files);}catch(error:unknown){if(error instanceof Error)throw new StoreBuildError('invalid');throw error;}
  if(await sweep()>=8)throw new StoreBuildError('unavailable');
  const nodeRoot=options.nodeRoot??'/opt/matrix/runtime/node';
  const runtimeInfo=await lstat(nodeRoot);if(!runtimeInfo.isDirectory()||![0,process.getuid?.()].includes(runtimeInfo.uid)||(runtimeInfo.mode&0o022)!==0)throw new StoreBuildError('unavailable');
  const versionEnv={PATH:nodeRoot+'/bin:/usr/bin:/bin',HOME:'/nonexistent',CI:'1'};
  const [nodeResult,pnpmResult]=await Promise.all([execute(join(nodeRoot,'bin/node'),['--version'],{env:versionEnv,cwd:nodeRoot,timeout:5000,maxBuffer:1024}),execute(join(nodeRoot,'bin/pnpm'),['--version'],{env:versionEnv,cwd:nodeRoot,timeout:5000,maxBuffer:1024})]);
  const nodeVersion=nodeResult.stdout.trim(),pnpmVersion=pnpmResult.stdout.trim();
  if(!/^v24\.\d+\.\d+$/.test(nodeVersion)||pnpmVersion!=='10.33.4')throw new StoreBuildError('unavailable');
  const policyDigest=createHash('sha256').update(STORE_BUILD_DRIVER).update(JSON.stringify(buildSandboxLaunch({source:'/source',dependencies:'/deps',driver:'/driver.mjs',nodeRoot:'/node',unit:'matrix-store-build-policy',uid:1000}).args)).digest('hex');
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
   const output=await execute(launch.command,launch.args,{env:launch.env,signal:abort,timeout:130_000,maxBuffer:40*1024*1024,killSignal:'SIGKILL',encoding:'utf8'});
   const entries:unknown=JSON.parse(output.stdout);
   if(!Array.isArray(entries)||entries.length>512)throw new StoreBuildError('build_failed');
   const dist=new Map<string,Buffer>();
   for(const value of entries){
    if(!value||typeof value!=='object'||typeof value.path!=='string'||typeof value.data!=='string'||value.data.length>12*1024*1024||dist.has(value.path))throw new StoreBuildError('build_failed');
    dist.set(value.path,Buffer.from(value.data,'base64'));
   }
   return {files:decodeAppBundle(encodeAppBundle('dist',dist),{kind:'dist'}).files,toolchain:{nodeVersion,pnpmVersion,policyDigest}};
  }catch(error:unknown){
   if(error instanceof StoreBuildError)throw error;
   console.warn('[app-store] Isolated build failed',error instanceof Error?error.name:'UnknownError');
   throw new StoreBuildError('build_failed');
  }finally{
   try{if(launch){
    // Stop the entire service cgroup, including descendants that outlived Vite.
    try{await execute('/usr/bin/systemctl',['--user','stop',`${unit}.service`],{env:launch.env,timeout:10_000,maxBuffer:16_384});}
    catch(error:unknown){
     // --collect removes completed transient units before stop can find them.
     let state='';try{state=(await execute('/usr/bin/systemctl',['--user','is-active',`${unit}.service`],{env:launch.env,timeout:5000,maxBuffer:1024})).stdout.trim();}
     catch(probe:unknown){if(probe&&typeof probe==='object'&&'stdout' in probe&&typeof probe.stdout==='string')state=probe.stdout.trim();}
     if(!['inactive','failed','unknown'].includes(state)){console.warn('[app-store] Build service drain failed',error instanceof Error?error.name:'UnknownError');throw new StoreBuildError('unavailable');}
    }
   }}finally{await rm(directory,{recursive:true,force:true});}
  }
 }
 return {build(files,signal){
  const pending=build(files,signal);active.add(pending);void pending.finally(()=>active.delete(pending)).catch((error:unknown)=>{if(!(error instanceof Error))console.warn('[app-store] Build promise failed');});return pending;
 },async close(){clearInterval(timer);stop.abort();await Promise.allSettled([...active]);}};
}
