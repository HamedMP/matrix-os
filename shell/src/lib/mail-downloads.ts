import {MailDeviceCacheRequestSchema,parseMailDeviceCache} from '@matrix-os/contracts';
export const MAIL_DOWNLOADS_STORAGE_PREFIX='matrix:edition-downloads:v1:';
type DeviceStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
let sessionGeneration=0;
/** Remove only Edition's device copies and fence requests from signed-out frames. */
export function clearBrowserMailDownloads(storage:DeviceStorage&Pick<Storage,'length'|'key'>){
 sessionGeneration++;
 for(let index=Math.min(storage.length,10_000)-1;index>=0;index--){const key=storage.key(index);if(key?.startsWith(MAIL_DOWNLOADS_STORAGE_PREFIX))storage.removeItem(key);}
}
export function mailDownloadsKey(scope:string){if(!scope||scope.length>512)throw new Error('Device downloads unavailable');return MAIL_DOWNLOADS_STORAGE_PREFIX+encodeURIComponent(scope);}
/** Scope comes from the signed-in shell, never an app request. */
export function createBrowserMailDownloads(scope:string,storage:DeviceStorage,current:()=>boolean=()=>true){
 const key=mailDownloadsKey(scope);
 const generation=sessionGeneration;
 return async(raw:unknown):Promise<unknown>=>{
  if(!current()||generation!==sessionGeneration)throw new Error('Device downloads unavailable');
  const request=MailDeviceCacheRequestSchema.parse(raw);
  if(request.action==='clear'){storage.removeItem(key);return null;}
  if(request.action==='save'){storage.setItem(key,request.raw);return null;}
  const cached=storage.getItem(key);
  if(cached!==null){try{parseMailDeviceCache(cached);}catch(error){console.warn('[edition-cache] Invalid downloads',error instanceof Error?error.name:'UnknownError');storage.removeItem(key);return{scope,raw:null};}}
  return{scope,raw:cached};
 };
}
/** Install once for the authenticated scope, so logout cannot mint a fresh bridge. */
export function createMailDownloadMessageHandler(options:{scope:string|null;appName:string;storage:DeviceStorage;expectedSource:()=>Window|null|undefined;origin:string;current:()=>boolean}){
 const bridge=options.scope?createBrowserMailDownloads(options.scope,options.storage,options.current):null;
 return async(event:MessageEvent):Promise<boolean>=>{
  const data=event.data,port=event.ports[0];
  if(data?.type!=='os:mail-downloads'||options.appName!=='edition'||data.app!=='edition'||event.source!==options.expectedSource()||!['null',options.origin].includes(event.origin)||!port)return false;
  try{if(!bridge)throw new Error('Device downloads unavailable');const value=await bridge(data.payload);port.postMessage({ok:true,value});}
  catch(error){console.warn('[edition-cache] Device request unavailable',error instanceof Error?error.name:'UnknownError');port.postMessage({ok:false});}
  finally{port.close();}
  return true;
 };
}
