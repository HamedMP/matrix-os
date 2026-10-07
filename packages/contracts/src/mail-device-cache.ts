import {z} from 'zod/v4';
import {MailId} from '#mail';
export const MAIL_DEVICE_CACHE_MAX_BYTES=5*1024*1024;
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const MailDownloadedMessageSchema=z.strictObject({
 id:MailId,sourceId:MailId,subject:z.string().max(1000),sender:z.string().max(1000),publication:z.string().max(1000),receivedAt:z.iso.datetime(),excerpt:z.string().max(4000),text:z.string().max(2*1024*1024).optional(),contentVersion:z.string().min(1).max(256),classification:z.enum(['newsletter','review','other']),saved:z.boolean(),read:z.boolean(),progress:z.number().min(0).max(1),revision,readingRevision:revision,partial:z.literal(false).optional(),
});
const DownloadedSource=z.object({id:MailId,connectionId:z.string().min(1).max(256),email:z.email().max(320),label:z.string().max(1000),scope:z.enum(['personal','work']),state:z.string().max(64),coverageStart:z.iso.datetime().optional(),lastSyncedAt:z.iso.datetime().optional()});
export const MailDeviceCacheSchema=z.strictObject({messages:z.array(MailDownloadedMessageSchema).max(50),sources:z.array(DownloadedSource).max(256),pending:z.array(z.strictObject({id:MailId,baseRevision:revision,saved:z.boolean().optional(),read:z.boolean().optional(),progress:z.number().min(0).max(1).optional()}).refine(p=>p.saved!==undefined||p.read!==undefined||p.progress!==undefined)).max(100)});
export type MailDeviceCache=z.infer<typeof MailDeviceCacheSchema>;
/** Portable UTF-8 sizing: native runtimes need not provide TextEncoder. */
export function mailDeviceCacheByteLength(value:string):number {
 let bytes=0;
 for(let index=0;index<value.length;index++){
  const code=value.charCodeAt(index);
  if(code<0x80)bytes++;
  else if(code<0x800)bytes+=2;
  else if(code>=0xd800&&code<=0xdbff&&index+1<value.length&&value.charCodeAt(index+1)>=0xdc00&&value.charCodeAt(index+1)<=0xdfff){bytes+=4;index++;}
  else bytes+=3;
 }
 return bytes;
}
export function parseMailDeviceCache(raw:string):MailDeviceCache{
 if(mailDeviceCacheByteLength(raw)>MAIL_DEVICE_CACHE_MAX_BYTES)throw new Error('Device download limit exceeded');
 return MailDeviceCacheSchema.parse(JSON.parse(raw));
}
export const MailDeviceCacheRequestSchema=z.discriminatedUnion('action',[
 z.strictObject({action:z.literal('load')}),z.strictObject({action:z.literal('save'),raw:z.string().max(MAIL_DEVICE_CACHE_MAX_BYTES).refine(raw=>{try{parseMailDeviceCache(raw);return true;}catch(error){if(error instanceof SyntaxError||error instanceof z.ZodError||error instanceof Error)return false;throw error;}})}),z.strictObject({action:z.literal('clear')}),
]);
export type MailDeviceCacheRequest=z.infer<typeof MailDeviceCacheRequestSchema>;
export interface MailDeviceDownloadsBridge{load():Promise<{scope:string;raw:string|null}>;save(raw:string):Promise<void>;clear():Promise<void>}
