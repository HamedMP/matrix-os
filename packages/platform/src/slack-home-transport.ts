import { signSlackBridgeRequest } from "@matrix-os/contracts/slack-bridge";

export interface SlackHome { ownerId:string;origin:string;token:string }
export function createSlackHomeTransport(options:{fetchImpl?:typeof fetch}={}) {
  const fetchImpl=options.fetchImpl??fetch;
  return async(home:SlackHome,operation:"events"|"authorize",payload:unknown,signal?:AbortSignal):Promise<{accepted?:boolean;allowed?:boolean}>=>{
    // The origin is resolved exclusively from the platform's reviewed machine registry.
    const origin=new URL(home.origin);
    if(origin.protocol!=="https:" || origin.pathname!=="/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Slack home unavailable");
    const path=`/api/internal/slack/${operation}`;
    const body=JSON.stringify(payload);
    const signature=await signSlackBridgeRequest({token:home.token,path,body});
    const response=await fetchImpl(`${origin.origin}${path}`,{method:"POST",headers:{"content-type":"application/json",...signature},
      body,redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000)});
    if(!response.ok) {await response.body?.cancel();throw new Error("Slack home unavailable");}
    const reader=response.body?.getReader();
    if(!reader) throw new Error("Slack home unavailable");
    const chunks:Uint8Array[]=[];let size=0;
    try {
      while(true) { const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
        if(size>4096) {await reader.cancel();throw new Error("Slack home unavailable");} chunks.push(next.value); }
    } finally {reader.releaseLock();}
    let value:unknown;
    try {value=JSON.parse(Buffer.concat(chunks,size).toString("utf8"));}
    catch(error:unknown) {if(!(error instanceof SyntaxError))console.warn("[slack-home] invalid reply",error instanceof Error?error.name:"UnknownError");throw new Error("Slack home unavailable");}
    if(!value || typeof value!=="object" || (operation==="events" && (!("accepted" in value) || value.accepted!==true))
      || (operation==="authorize" && (!("allowed" in value) || typeof value.allowed!=="boolean"))) throw new Error("Slack home unavailable");
    return value;
  };
}
