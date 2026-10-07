import {MailActionRequestSchema} from '@matrix-os/contracts';
import {gatewayAuthHeaders} from './integrations.js';
import {wrapExternalContent} from '../security/external-content.js';
/** The read endpoint retains installed-app grants and cannot approve source writes. */
export async function readMailArchiveHandler(raw:unknown,fetcher:typeof fetch=fetch){
 const error=()=>({isError:true,content:[{type:'text' as const,text:'Retained email is unavailable. Check the selected account and app grant.'}]});
 const parsed=MailActionRequestSchema.safeParse(raw);if(!parsed.success||!['sources','messages','message'].includes(parsed.data.action))return error();
 const signal=AbortSignal.timeout(10_000);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const cancel=()=>{void reader?.cancel().catch(e=>console.warn('[mail-tool] Cleanup failed',e instanceof Error?e.name:'UnknownError'));};
 try{
  const response=await fetcher(`${process.env.GATEWAY_URL??'http://localhost:4000'}/api/mail/read`,{method:'POST',headers:gatewayAuthHeaders(),body:JSON.stringify(parsed.data),signal,redirect:'error'});
  const length=response.headers.get('content-length');if(!response.ok||!response.body||(length!==null&&(!/^\d+$/.test(length)||Number(length)>3*1024*1024))){await response.body?.cancel();return error();}
  reader=response.body.getReader();signal.addEventListener('abort',cancel,{once:true});const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>3*1024*1024||chunks.length>=4096){await reader.cancel();return error();}chunks.push(next.value);}
  signal.throwIfAborted();const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes))) as unknown;
  return{content:[{type:'text' as const,text:wrapExternalContent(JSON.stringify(data),{source:'email',includeWarning:true})}]};
 }catch(e){console.warn('[mail-tool] Read unavailable',e instanceof Error?e.name:'UnknownError');return error();}
 finally{signal.removeEventListener('abort',cancel);reader?.releaseLock();}
}
