import {MailDeviceCacheRequestSchema,parseMailDeviceCache,type MailDeviceDownloadsBridge,type MailDeviceCacheRequest} from '@matrix-os/contracts';
import {z} from 'zod/v4';
export const NATIVE_MAIL_DOWNLOADS_CHANNEL='native-app:mail-downloads';
const Load=z.strictObject({scope:z.string().regex(/^[a-f0-9]{64}$/),raw:z.string().nullable()});
export function createNativeMailDownloads(invoke:(input:MailDeviceCacheRequest)=>Promise<unknown>):MailDeviceDownloadsBridge {
 async function request(input:MailDeviceCacheRequest){const parsed=MailDeviceCacheRequestSchema.safeParse(input);if(!parsed.success)throw new Error('Downloads unavailable');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([invoke(parsed.data),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Downloads unavailable')),10000);})]);}
  catch(error){console.warn('[mail-downloads] request failed',error instanceof Error?error.name:'UnknownError');throw new Error('Downloads unavailable');}finally{if(timer)clearTimeout(timer);}
 }
 return Object.freeze({async load(){try{const result=Load.parse(await request({action:'load'}));if(result.raw!==null)parseMailDeviceCache(result.raw);return result;}catch(error){console.warn('[mail-downloads] invalid result',error instanceof Error?error.name:'UnknownError');throw new Error('Downloads unavailable');}},async save(raw:string){await request({action:'save',raw});},async clear(){await request({action:'clear'});}});
}
