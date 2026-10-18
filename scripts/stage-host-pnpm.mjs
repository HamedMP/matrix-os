#!/usr/bin/env node
import {createHash,timingSafeEqual} from 'node:crypto';
import {mkdir,mkdtemp,lstat,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
export const PNPM_VERSION='10.33.4';
export const PNPM_URL=`https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`;
const INTEGRITY='sha512-HGezs1my1AgRm6HtKJ80uPw8aHNBK+xv0mT73IJInlEPy+y5zp0i2ufzt2Jp2EQQRgFL3KU7mXnNelYa1jG4AA==';
const MAX_ARCHIVE_BYTES=16*1024*1024;const run=promisify(execFile);
async function directory(path){try{await mkdir(path,{mode:0o755});}catch(error){if(error?.code!=='EEXIST')throw error;}const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid runtime directory');}
async function archiveBytes(response){
 if(!response.ok)throw new Error('Pinned pnpm download failed');const length=response.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_ARCHIVE_BYTES))throw new Error('Pinned pnpm archive size exceeded');if(!response.body)throw new Error('Missing pnpm archive');
 const reader=response.body.getReader();const chunks=[];let total=0;
 try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>MAX_ARCHIVE_BYTES)throw new Error('Pinned pnpm archive size exceeded');chunks.push(Buffer.from(next.value));}return Buffer.concat(chunks);}
 finally{try{await reader.cancel();}finally{reader.releaseLock();}}
}
/** Stage only the official immutable package. No ambient package-manager configuration or install scripts run. */
export async function stageHostPnpm(runtimeRoot,{fetcher=fetch}={}){
 const root=resolve(runtimeRoot);const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o022)!==0)throw new Error('Unsafe runtime root permissions');
 const bin=join(root,'bin');await directory(bin);const temporary=await mkdtemp(join(root,'.pnpm-stage-'));const target=join(root,'lib/node_modules/pnpm');const executable=join(bin,'pnpm');let created=false,linked=false,complete=false;
 try{
  const response=await fetcher(PNPM_URL,{redirect:'error',signal:AbortSignal.timeout(30_000)});const bytes=await archiveBytes(response);
  const expected=Buffer.from(INTEGRITY.slice('sha512-'.length),'base64');const actual=createHash('sha512').update(bytes).digest();if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('Pinned pnpm archive integrity mismatch');
  const archive=join(temporary,'pnpm.tgz');await writeFile(archive,bytes,{flag:'wx',mode:0o600});await directory(join(root,'lib'));await directory(join(root,'lib/node_modules'));
  await mkdir(target,{mode:0o755});created=true;
  await run('tar',['-xzf',archive,'--strip-components=1','-C',target],{env:{PATH:'/usr/bin:/bin'},timeout:30_000,maxBuffer:1024*1024});
  const manifest=JSON.parse(await readFile(join(target,'package.json'),'utf8'));if(manifest.name!=='pnpm'||manifest.version!==PNPM_VERSION)throw new Error('Pinned pnpm package version mismatch');
  await symlink('../lib/node_modules/pnpm/bin/pnpm.cjs',executable);linked=true;
  const version=await run(executable,['--version'],{cwd:temporary,env:{PATH:bin+':/usr/bin:/bin',HOME:temporary,CI:'1'},timeout:10_000,maxBuffer:4096});if(version.stdout.trim()!==PNPM_VERSION)throw new Error('Staged pnpm executable version mismatch');complete=true;
 }finally{
  try{if(!complete){try{if(linked)await rm(executable);}finally{if(created)await rm(target,{recursive:true,force:true});}}}
  finally{await rm(temporary,{recursive:true,force:true});}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==3)throw new Error('Usage: stage-host-pnpm.mjs <runtime-node-root>');
 await stageHostPnpm(process.argv[2]);console.log(`Staged pnpm ${PNPM_VERSION}`);
}
