import {randomUUID} from 'node:crypto';
import {rename,unlink,rm,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {pinDirectory,type PinnedDirectory,isFsError} from '../app-gallery/pinned-directory.js';
export async function withStoreDirectory<T>(homePath:string,segments:readonly string[],operation:(directory:PinnedDirectory)=>Promise<T>,create=true):Promise<T>{
 let current=await pinDirectory(homePath);
 try{
  for(const segment of ['data','app-store',...segments]){const next=create?await current.ensureChild(segment):await current.child(segment);await current.close();current=next;}
  if(!await current.isPrivate())throw new Error('Private state unavailable');
  return await operation(current);
 }finally{await current.close();}
}
export async function atomicPrivateFile(directory:PinnedDirectory,name:string,bytes:Buffer):Promise<void>{
 const temporary=`tmp-${randomUUID()}`;const handle=await directory.openFile(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY);
 try{
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  await rename(`${directory.path}/${temporary}`,`${directory.path}/${name}`);
 }finally{try{await unlink(`${directory.path}/${temporary}`);}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}}
}
/** Bounded recurring cleanup, skipping symlinks; called by services before admission. */
export async function sweepPrivateChildren(directory:PinnedDirectory,pattern:RegExp,maxAgeMs:number,maxEntries=128):Promise<number>{
 let count=0,visited=0;
 for await(const entry of await directory.entries()){
  if(++visited>maxEntries)throw new Error('Private state entry cap');
  if(!pattern.test(entry.name))continue;
  const info=await lstat(`${directory.path}/${entry.name}`);
  if(info.isSymbolicLink())continue;
  count++;
  if(Date.now()-info.mtimeMs>maxAgeMs){await rm(`${directory.path}/${entry.name}`,{recursive:info.isDirectory(),force:true});count--;}
 }
 return count;
}
