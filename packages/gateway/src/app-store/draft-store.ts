import {randomUUID} from 'node:crypto';import {rm} from 'node:fs/promises';
import {AppStoreDraftDetailSchema,type AppStoreDraftDetail} from '@matrix-os/contracts/app-store-gateway';
import {AppStoreIdSchema} from '@matrix-os/contracts/app-store';
import {encodeAppBundle,decodeAppBundle} from '@matrix-os/contracts/app-store-bundle';
import {withStoreDirectory,atomicPrivateFile,sweepPrivateChildren} from './private-state.js';
import {isFsError} from '../app-gallery/pinned-directory.js';
export function createDraftStore(homePath:string){
 return {
  async list():Promise<AppStoreDraftDetail[]>{return withStoreDirectory(homePath,['drafts'],async root=>{
   await sweepPrivateChildren(root,/^[0-9a-f-]{36}$/,7*86400_000,64);const drafts:AppStoreDraftDetail[]=[];
   for await(const entry of await root.entries()){
    if(!AppStoreIdSchema.safeParse(entry.name).success||!entry.isDirectory()||entry.isSymbolicLink())continue;
    if(drafts.length>=16)break;const directory=await root.child(entry.name);
    try{drafts.push(AppStoreDraftDetailSchema.parse(JSON.parse((await directory.readFile('draft.json',1024*1024)).toString('utf8'))));}
    catch(error:unknown){console.warn('[app-store] Draft recovery unavailable',error instanceof Error?error.name:'UnknownError');}
    finally{await directory.close();}
   }return drafts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  });},
  async read(id:string):Promise<AppStoreDraftDetail>{AppStoreIdSchema.parse(id);return withStoreDirectory(homePath,['drafts',id],async dir=>AppStoreDraftDetailSchema.parse(JSON.parse((await dir.readFile('draft.json',1024*1024)).toString('utf8'))),false);},
  async write(draft:AppStoreDraftDetail):Promise<void>{AppStoreDraftDetailSchema.parse(draft);await withStoreDirectory(homePath,['drafts',draft.id],dir=>atomicPrivateFile(dir,'draft.json',Buffer.from(JSON.stringify(draft))));},
  async files(id:string,which:'original'|'prepared'):Promise<Map<string,Buffer>>{AppStoreIdSchema.parse(id);return withStoreDirectory(homePath,['drafts',id],async dir=>decodeAppBundle(await dir.readFile(`${which}.bundle`,16*1024*1024),{kind:'source'}).files,false);},
  async writeFiles(id:string,which:'original'|'prepared',files:ReadonlyMap<string,Buffer>):Promise<void>{AppStoreIdSchema.parse(id);await withStoreDirectory(homePath,['drafts',id],dir=>atomicPrivateFile(dir,`${which}.bundle`,encodeAppBundle('source',files)));},
  async delete(id:string):Promise<void>{AppStoreIdSchema.parse(id);await withStoreDirectory(homePath,['drafts'],async root=>{try{const child=await root.child(id);await child.close();await rm(`${root.path}/${id}`,{recursive:true});}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}});},
  id:()=>randomUUID(),
 };
}
export type DraftStore=ReturnType<typeof createDraftStore>;
