import { APP_BUNDLE_LIMITS, validateBundlePath } from '@matrix-os/contracts/app-store-bundle';
import { OwnerAppSlugSchema } from '@matrix-os/contracts/app-store-gateway';
import { pinDirectory, type PinnedDirectory } from '../app-gallery/pinned-directory.js';

/** Read through pinned directory capabilities; owner source is never mutated. */
export async function snapshotOwnerApp(homePath:string,slug:string):Promise<Map<string,Buffer>> {
 OwnerAppSlugSchema.parse(slug);
 const owner=await pinDirectory(homePath);let apps:PinnedDirectory|undefined,root:PinnedDirectory|undefined;
 const files=new Map<string,Buffer>();let total=0,entries=0;
 async function visit(directory:PinnedDirectory,prefix:string,depth:number):Promise<void>{
  if(depth>APP_BUNDLE_LIMITS.maxSegments)throw new Error('Source nesting limit');
  for await(const entry of await directory.entries()){
   if(++entries>2048)throw new Error('Source entry limit');
   const key=prefix?`${prefix}/${entry.name}`:entry.name;
   if(entry.name==='node_modules'||entry.name==='.git'||entry.name==='.matrix-store'||entry.name==='dist'||entry.name.startsWith('.env')||entry.name.endsWith('.log')||entry.name==='.build-stamp')continue;
   validateBundlePath(key,'source');
   if(entry.isSymbolicLink())throw new Error('Source links are unsupported');
   if(entry.isDirectory()){const child=await directory.child(entry.name);try{await visit(child,key,depth+1);}finally{await child.close();}}
   else{
    if(!entry.isFile()||files.size>=APP_BUNDLE_LIMITS.maxFiles)throw new Error('Source entry rejected');
    const bytes=await directory.readFile(entry.name,Math.min(APP_BUNDLE_LIMITS.maxFileBytes,APP_BUNDLE_LIMITS.maxTotalBytes-total));
    total+=bytes.length;files.set(key,bytes);
   }
  }
 }
 try{apps=await owner.child('apps');root=await apps.child(slug);await visit(root,'',0);return files;}
 finally{try{await root?.close();}finally{try{await apps?.close();}finally{await owner.close();}}}
}
