import { mintRoutineBrowserProof, routineBrowserPurposePath, routineBrowserSession, routineBrowserTuple } from './routine-origin-proof.js';
import type { OwnerApprovalProxyInput } from './canonical-owner-approval-proxy.js';
/** Independent from Full Access: one browser submit can need both non-interchangeable proofs. */
export async function authenticatedRoutineOriginProxyProof(input: OwnerApprovalProxyInput): Promise<string | null | {status:400|408|413|503}> {
  const machine=input.machine;
  if (!routineBrowserPurposePath(input.method,input.path) || !input.platformSecret || !machine?.machineId
    || machine.handle!==input.handle || machine.clerkUserId!==input.identity.userId || input.identity.source!=='auth') return null;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const cancel=()=>{
    void reader?.cancel().catch(error=>console.warn('[routine-origin] Body cancellation unavailable',error instanceof Error?error.name:'UnknownError'));
    void input.request.body?.cancel().catch(error=>console.warn('[routine-origin] Request cancellation unavailable',error instanceof Error?error.name:'UnknownError'));
  };
  try {
    reader=input.request.clone().body?.getReader();if(!reader)return null;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('RoutineOriginBodyTimeout')),input.timeoutMs??5000);timer.unref?.();});
    const limit=input.path.endsWith('/resolve')?2048:128*1024,buffer=Buffer.alloc(limit);let bytes=0;
    for(;;){const next=await Promise.race([reader.read(),timeout]);if(next.done)break;bytes+=next.value.byteLength;
      if(bytes>limit){cancel();return{status:413};}buffer.set(next.value,bytes-next.value.byteLength);}
    const body=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytes));
    const tuple=routineBrowserTuple({method:input.method,path:input.path,body,handle:input.handle,runtimeSlot:machine.runtimeSlot,machineId:machine.machineId,ownerId:input.identity.userId});
    clearTimeout(timer);
    if(!tuple)return null;
    const session=await routineBrowserSession(input);
    return session?mintRoutineBrowserProof({tuple,secret:input.platformSecret,session}):null;
  } catch(error:unknown) {
    cancel();if(error instanceof Error&&error.message==='RoutineOriginBodyTimeout')return{status:408};
    console.warn('[routine-origin] Browser proof unavailable',error instanceof Error?error.name:'UnknownError');return{status:error instanceof TypeError?400:503};
  } finally {clearTimeout(timer);reader?.releaseLock();}
}
