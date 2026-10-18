/** Trusted driver runs only inside the namespace. No host writable mount is exposed. */
export const STORE_BUILD_DRIVER = String.raw`
import { cp,mkdir,readdir,lstat,readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
await mkdir('/workspace/app',{recursive:true});
await mkdir('/workspace/home',{recursive:true});
await cp('/source','/workspace/app',{recursive:true,dereference:false});
const env={PATH:'/opt/matrix/runtime/node/bin:/usr/bin:/bin',HOME:'/workspace/home',CI:'1',NODE_OPTIONS:'--max-old-space-size=768',npm_config_registry:'https://registry.npmjs.org',npm_config_userconfig:'/dev/null'};
async function run(command,args){
 await new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:'/workspace/app',env,stdio:['ignore','pipe','pipe']});
  let bytes=0; const drain=data=>{bytes+=data.length;if(bytes>524288){child.kill('SIGKILL');reject(new Error('Build output limit'));}};
  child.stdout.on('data',drain);child.stderr.on('data',drain);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Build failed')));
 });
}
await run('/opt/matrix/runtime/node/bin/pnpm',['install','--offline','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile','--store-dir=/workspace/store','--config.node-linker=hoisted','--config.manage-package-manager-versions=false','--config.verify-store-integrity=true']);
await run('/opt/matrix/runtime/node/bin/node',['/workspace/app/node_modules/vite/bin/vite.js','build','--base','./','--outDir','/workspace/app/dist']);
const files=[];let total=0,entries=0;
async function visit(dir,prefix='',depth=0){
 if(depth>12)throw new Error('Build depth limit');
 for(const name of await readdir(dir)){
  if(++entries>1024)throw new Error('Build entry limit');
  if(!/^[A-Za-z0-9._@+-]{1,128}$/.test(name)||name==='.'||name==='..')throw new Error('Build path rejected');
  const path=dir+'/'+name,key=prefix?prefix+'/'+name:name,info=await lstat(path);
  if(info.isSymbolicLink()||(info.isFile()&&info.nlink>1))throw new Error('Build link rejected');
  if(info.isDirectory()){await visit(path,key,depth+1);continue;}
  if(!info.isFile()||info.size>8388608||files.length>=512||(total+=info.size)>25165824)throw new Error('Build size limit');
  files.push({path:key,data:(await readFile(path)).toString('base64')});
 }
}
await visit('/workspace/app/dist');
if(!files.some(f=>f.path==='index.html'))throw new Error('Missing build');
process.stdout.write(JSON.stringify(files));
`;
