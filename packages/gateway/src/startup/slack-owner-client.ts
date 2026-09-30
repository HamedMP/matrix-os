import { z } from "zod/v4";
import type { SlackBridgeEnvelope } from "@matrix-os/contracts/slack-bridge";

const ContextSchema=z.object({available:z.literal(true),untrusted:z.literal(true),partial:z.boolean(),messages:z.array(z.object({
  user:z.string().max(80).optional(),ts:z.string().max(32),thread_ts:z.string().max(32).optional(),text:z.string().max(16_384).optional(),
}).strict()).max(20)}).strict();
export function createSlackOwnerClient(options:{platformUrl:string;handle:string;token:string;fetchImpl?:typeof fetch}) {
  const origin=new URL(options.platformUrl);
  if(!["http:","https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname!=="/"
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.handle) || !/^[a-f0-9]{64}$/.test(options.token))throw new Error("Slack transport unavailable");
  const fetchImpl=options.fetchImpl??fetch;
  async function rpc(path:string,payload:unknown){
    const response=await fetchImpl(`${origin.origin}${path}`,{method:"POST",body:JSON.stringify(payload),redirect:"error",signal:AbortSignal.timeout(10_000),
      headers:{"content-type":"application/json",authorization:`Bearer ${options.token}`,"x-matrix-handle":options.handle}});
    if(!response.ok){await response.body?.cancel();return{status:response.status,body:null};}
    const reader=response.body?.getReader();if(!reader)throw new Error("Slack transport unavailable");
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
      if(size>16*1024){await reader.cancel();throw new Error("Slack transport unavailable");}chunks.push(next.value);}}
    finally{reader.releaseLock();}
    const body:unknown=JSON.parse(Buffer.concat(chunks,size).toString("utf8"));
    return{status:response.status,body};
  }
  return{
    async react(envelope:SlackBridgeEnvelope){
      try {
        const result=await rpc("/internal/slack/reactions",{teamId:envelope.event.teamId,eventId:envelope.event.eventId});
        if(!z.object({reacted:z.literal(true)}).strict().safeParse(result.body).success)console.warn("[slack-owner] progress reaction unavailable");
      } catch(error:unknown) {
        console.warn("[slack-owner] progress reaction unavailable",error instanceof Error?error.name:"UnknownError");
      }
    },
    async readThread(envelope:SlackBridgeEnvelope){
      try{
        const result=await rpc("/internal/slack/context",{teamId:envelope.event.teamId,eventId:envelope.event.eventId});
        const parsed=ContextSchema.safeParse(result.body);
        return parsed.success?{messages:parsed.data.messages,partial:parsed.data.partial}:null;
      }catch(error:unknown){console.warn("[slack-owner] thread context unavailable",error instanceof Error?error.name:"UnknownError");return null;}
    },
    async sendReply(input:{envelope:SlackBridgeEnvelope;text:string}):Promise<{status:"sent";messageTs:string}|{status:"retryable"|"uncertain"}>{
      try{
        const result=await rpc("/internal/slack/replies",{teamId:input.envelope.event.teamId,eventId:input.envelope.event.eventId,text:input.text});
        const sent=z.object({sent:z.literal(true),messageTs:z.string().regex(/^\d{1,16}\.\d{1,8}$/)}).strict().safeParse(result.body);
        if(sent.success)return{status:"sent",messageTs:sent.data.messageTs};
        return{status:result.status===429?"retryable":"uncertain"};
      }catch(error:unknown){console.warn("[slack-owner] delivery outcome unknown",error instanceof Error?error.name:"UnknownError");return{status:"uncertain"};}
    },
  };
}
