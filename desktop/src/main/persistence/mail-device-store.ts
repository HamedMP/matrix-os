import {constants} from 'node:fs';
import {mkdir,open,lstat,readdir,rename,unlink,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod/v4';
import {MAIL_DEVICE_CACHE_MAX_BYTES,MailDeviceCacheRequestSchema,parseMailDeviceCache,type MailDeviceCacheRequest} from '@matrix-os/contracts';

const CACHE_FILE='cache.json';
const TEMP=/^\.cache-[a-f0-9]{32}\.tmp$/;
const Envelope=z.strictObject({scope:z.string().regex(/^[a-f0-9]{64}$/),raw:z.string().max(MAIL_DEVICE_CACHE_MAX_BYTES)});
interface Status {signedIn:boolean;userId?:string;runtimeSlot:string;authGeneration:number}
interface Authority {getStatus():Status;getGatewayOrigin():string}
export interface MailDeviceStore {request(raw:unknown,authorized:()=>boolean):Promise<unknown>}
function absent(error:unknown):boolean{return(error as NodeJS.ErrnoException)?.code==='ENOENT';}

/** Offline downloads are optional: storage failure must not abort Electron boot. */
export async function startMailDeviceStore(store:ReturnType<typeof createMailDeviceStore>):Promise<typeof store|null> {
 try{await store.initialize();return store;}
 catch(error){
  console.warn('[mail-downloads] startup unavailable',error instanceof Error?error.name:'UnknownError');
  try{await store.dispose();}catch(disposal){console.warn('[mail-downloads] startup cleanup failed',disposal instanceof Error?disposal.name:'UnknownError');}
  return null;
 }
}

/** One owner/runtime snapshot; serialization plus live authority prevents late writes after logout. */
export function createMailDeviceStore(deps:{dir:string;auth:Authority;beforePublish?:()=>Promise<void>}) {
 let folder='';let tail=Promise.resolve();let pending=0;let epoch=0;let disposed=false;let observed='';
 let rootIdentity:{dev:number;ino:number}|undefined;
 function scope(){const status=deps.auth.getStatus();if(!status.signedIn||!status.userId)return null;
  const origin=new URL(deps.auth.getGatewayOrigin());if(!['https:','http:'].includes(origin.protocol))throw new Error('Downloads unavailable');
  const key=createHash('sha256').update(JSON.stringify([status.userId,origin.origin,status.runtimeSlot])).digest('hex');return{key,generation:status.authGeneration};
 }
 function stamp(){const value=scope();return value?`${value.key}:${value.generation}`:'signed-out';}
 async function folderReady(){
  folder ||= join(await realpath(deps.dir),'edition-downloads');
  await mkdir(folder,{recursive:true,mode:0o700});const stat=await lstat(folder);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(folder)!==folder)throw new Error('Downloads unavailable');
  if(rootIdentity&&(stat.dev!==rootIdentity.dev||stat.ino!==rootIdentity.ino))throw new Error('Downloads unavailable');
  rootIdentity??={dev:stat.dev,ino:stat.ino};await open(folder,constants.O_RDONLY|constants.O_NOFOLLOW).then(async handle=>{try{await handle.chmod(0o700);}finally{await handle.close();}});
 }
 async function safeRemove(name:string){try{const stat=await lstat(join(folder,name));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Downloads unavailable');await unlink(join(folder,name));}catch(error){if(!absent(error))throw error;}}
 async function clear(){await folderReady();await safeRemove(CACHE_FILE);}
 function queue<T>(work:()=>Promise<T>):Promise<T>{const operation=tail.then(work);tail=operation.then(()=>undefined,error=>{console.warn('[mail-downloads] operation failed',error instanceof Error?error.name:'UnknownError');});return operation;}
 async function load(){await folderReady();let handle;try{handle=await open(join(folder,CACHE_FILE),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(absent(error))return null;throw error;}
  try{const maximum=MAIL_DEVICE_CACHE_MAX_BYTES*2+1024;const stat=await handle.stat();if(!stat.isFile()||stat.size>maximum)throw new Error('Downloads unavailable');
   // JSON's outer string escaping can double the bounded inner cache. Read the exact bounded file descriptor.
   const chunks:Buffer[]=[];let size=0;
   while(true){const chunk=Buffer.alloc(Math.min(64*1024,maximum-size+1));const read=await handle.read(chunk,0,chunk.length,null);if(!read.bytesRead)break;size+=read.bytesRead;if(size>maximum)throw new Error('Downloads unavailable');chunks.push(chunk.subarray(0,read.bytesRead));}
   const parsed=Envelope.parse(JSON.parse(Buffer.concat(chunks,size).toString('utf8')));parseMailDeviceCache(parsed.raw);return parsed;
  }finally{await handle.close();}
 }
 async function save(value:{scope:string;raw:string},live:()=>boolean){await folderReady();const name=`.cache-${randomUUID().replaceAll('-','')}.tmp`;const path=join(folder,name);let created=false;
  try{const handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
   try{await handle.writeFile(JSON.stringify(value),'utf8');await handle.sync();}finally{await handle.close();}
   await deps.beforePublish?.();await folderReady();if(!live())throw new Error('Downloads unavailable');
   // Fail closed on a caller-created final symlink before replacing the single cache slot.
   try{const previous=await lstat(join(folder,CACHE_FILE));if(!previous.isFile()||previous.isSymbolicLink())throw new Error('Downloads unavailable');}catch(error){if(!absent(error))throw error;}
   await rename(path,join(folder,CACHE_FILE));created=false;
   const directory=await open(folder,constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
   if(!live()){await safeRemove(CACHE_FILE);throw new Error('Downloads unavailable');}
  }finally{if(created)await safeRemove(name);}
 }
 async function initialize(){observed=stamp();await queue(async()=>{await folderReady();
  // Only our private atomic names are swept. All normal attempts remove their temp in finally.
  const names=await readdir(folder);if(names.length>128)throw new Error('Downloads unavailable');for(const name of names)if(TEMP.test(name))await safeRemove(name);
  try{const stored=await load();if(stored&&stored.scope!==scope()?.key)await clear();}
  catch(error){if(!(error instanceof SyntaxError||error instanceof z.ZodError))throw error;console.warn('[mail-downloads] malformed cache discarded',error.name);await clear();}
 });}
 function authChanged(){const next=stamp();if(next===observed)return tail;observed=next;epoch++;return queue(clear);}
 async function request(raw:unknown,authorized:()=>boolean){
  if(disposed||!authorized()||pending>=8)throw new Error('Downloads unavailable');const parsed=MailDeviceCacheRequestSchema.safeParse(raw);if(!parsed.success)throw new Error('Downloads unavailable');
  const bound=scope();if(!bound)throw new Error('Downloads unavailable');const generation=epoch;const expected=stamp();
  const live=()=>!disposed&&generation===epoch&&expected===stamp()&&authorized();pending++;
  try{return await queue(async()=>{if(!live())throw new Error('Downloads unavailable');const input:MailDeviceCacheRequest=parsed.data;
   if(input.action==='save'){await save({scope:bound.key,raw:input.raw},live);return;}
   if(input.action==='clear'){await clear();if(!live())throw new Error('Downloads unavailable');return;}
   const stored=await load();if(!live())throw new Error('Downloads unavailable');if(stored&&stored.scope!==bound.key){await clear();return{scope:bound.key,raw:null};}return{scope:bound.key,raw:stored?.raw??null};
  });}finally{pending--;}
 }
 async function dispose(){disposed=true;epoch++;await tail;}
 return{initialize,request,authChanged,dispose};
}
