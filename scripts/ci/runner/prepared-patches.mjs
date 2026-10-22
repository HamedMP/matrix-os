import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const maxPatches=8,maxPatchBytes=2*1024*1024,maxTotalBytes=8*1024*1024;
const unquote=value=>value.replace(/^(['"])(.*)\1$/,'$2');
export function parsePreparedPatches(lock) {
  if(typeof lock!=='string'||Buffer.byteLength(lock)>20*1024*1024)throw new Error('Invalid prepared lockfile');
  const lines=lock.split('\n'); const start=lines.indexOf('patchedDependencies:');
  if(start<0)return [];
  const result=[]; let current;
  const finish=()=>{
    if(!current)return;
    if(!/^[a-f0-9]{64}$/.test(current.hash||'') || !/^patches\/[a-zA-Z0-9][a-zA-Z0-9._@+-]{0,200}\.patch$/.test(current.path||''))throw new Error('Invalid prepared patch path/hash');
    if(result.some(entry=>entry.path===current.path)||result.length>=maxPatches)throw new Error('Duplicate/excess prepared patches');
    result.push(current);current=undefined;
  };
  for(const line of lines.slice(start+1)) {
    if(!line.trim())continue;
    if(!line.startsWith(' '))break;
    if(/^  [^ ].*:$/.test(line)){finish();current={};continue;}
    const field=line.match(/^    (hash|path): (.+)$/);
    if(!field||!current||Object.hasOwn(current,field[1]))throw new Error('Unsupported prepared patch field');
    current[field[1]]=unquote(field[2]);
  }
  finish();return result;
}
export async function fetchPreparedPatches(lock,sha,directory,options={}) {
  if(!/^[a-f0-9]{40}$/.test(sha||''))throw new Error('Exact prepared source SHA required');
  const patches=parsePreparedPatches(lock);if(!patches.length)return;
  const patchDir=resolve(directory,'patches');
  try{await mkdir(patchDir,{mode:0o755});}
  catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='EEXIST'))throw error;}
  const info=await lstat(patchDir);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid prepared patch directory');
  let total=0;const created=[];
  try {
    for(const patch of patches){
      const response=await (options.fetch??fetch)(`https://raw.githubusercontent.com/HamedMP/matrix-os/${sha}/${patch.path}`,{signal:AbortSignal.timeout(120000),redirect:'error'});
      if(!response.ok||!response.body||Number(response.headers.get('content-length')||0)>maxPatchBytes){await response.body?.cancel();throw new Error('Prepared patch download rejected');}
      const chunks=[];let length=0;
      for await(const chunk of response.body){length+=chunk.byteLength;total+=chunk.byteLength;if(length>maxPatchBytes||total>maxTotalBytes)throw new Error('Prepared patch download exceeds bound');chunks.push(chunk);}
      const content=Buffer.concat(chunks,length);
      if(createHash('sha256').update(content).digest('hex')!==patch.hash)throw new Error('Prepared patch digest mismatch');
      const destination=resolve(directory,patch.path);
      await writeFile(destination,content,{flag:'wx',mode:0o644});created.push(destination);
    }
  } catch(error){await Promise.all(created.map(path=>unlink(path)));throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [lockPath,sha,directory]=process.argv.slice(2);
  await fetchPreparedPatches(await readFile(lockPath,'utf8'),sha,directory);
}
