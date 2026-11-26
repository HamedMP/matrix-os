import type { BotResourceGrantProviders } from "../bots/resource-grant-scope.js";
import type { SlackBotPlatform, SlackPlatformConnection } from "./slack-platform.js";
import type { SummaryAccess } from "../slack/mention-summary.js";
import { z } from "zod/v4";
import { SlackAgentChannelSchema, type SlackAgentChannel, SlackThreadContextEnrollmentRequestSchema, SlackThreadContextEnrollmentResponseSchema, type SlackThreadContextEnrollmentRequest, SlackEnrolledContextRequestSchema, SlackEnrolledContextResponseSchema, type SlackEnrolledContextRequest, SlackPrivateThreadContextResponseSchema, SlackThreadContextAccessResponseSchema, type SlackBridgeEnvelope, type SlackThreadContextAccess } from "@matrix-os/contracts/slack-bridge";

const ContextSchema=z.object({available:z.literal(true),untrusted:z.literal(true),partial:z.boolean(),messages:z.array(z.object({
  user:z.string().max(80).optional(),ts:z.string().max(32),thread_ts:z.string().max(32).optional(),text:z.string().max(16_384).optional(),
}).strict()).max(20)}).strict();
export function createSlackOwnerClient(options: SlackPlatformConnection & { fetchImpl?: typeof fetch }) {
  const origin=new URL(options.platformUrl);
  const local=["localhost","127.0.0.1","[::1]"].includes(origin.hostname);
  if((origin.protocol!=="https:" && !(origin.protocol==="http:" && local)) || origin.username || origin.password || origin.search || origin.hash || origin.pathname!=="/"
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.handle) || !/^[a-f0-9]{64}$/.test(options.token))throw new Error("Slack transport unavailable");
  const fetchImpl=options.fetchImpl??fetch;
  async function rpc(path:string,payload:unknown,signal?:AbortSignal,timeoutMs=2_000,maxBytes=16*1024){
    const response=await fetchImpl(`${origin.origin}${path}`,{method:"POST",body:JSON.stringify(payload),redirect:"error",signal:signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(10_000),
      headers:{"content-type":"application/json",authorization:`Bearer ${options.token}`,"x-matrix-handle":options.handle}});
    if(!response.ok && response.status!==503){
      const header=response.headers.get("retry-after");
      const seconds=header!==null && /^\d{1,6}$/.test(header)?Number(header):60;
      const retryAfterMs=response.status===429?Math.min(3600,Math.max(1,seconds))*1000:undefined;
      try{await response.body?.cancel();}catch(error:unknown){console.warn("[slack-owner] rejected response cleanup failed",error instanceof Error?error.name:"UnknownError");}
      return{status:response.status,body:null,retryAfterMs};
    }
    const reader=response.body?.getReader();if(!reader)throw new Error("Slack transport unavailable");
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new Error("Slack transport unavailable");}chunks.push(next.value);}}
    finally{reader.releaseLock();}
    const body:unknown=JSON.parse(Buffer.concat(chunks,size).toString("utf8"));
    return{status:response.status,body,retryAfterMs:undefined};
  }
  return{
    async listAgentRouteChannels(signal?: AbortSignal, channelId?: string): Promise<SlackAgentChannel[]> {
      if (!options.devTarget?.agentRoutes || channelId !== undefined && !SlackAgentChannelSchema.shape.channelId.safeParse(channelId).success) return [];
      try {
        const response = await rpc("/internal/slack/agent-channels", channelId ? { channelId } : {}, signal, 7500);
        const parsed = z.strictObject({ channels: z.array(SlackAgentChannelSchema).max(2) }).safeParse(response.body);
        if (response.status !== 200 || !parsed.success) throw new Error("Slack channel verification unavailable");
        return parsed.data.channels.filter(c => c.ownerId === options.devTarget!.ownerId
          && c.runtimeId === options.devTarget!.machineId && c.appId === options.devTarget!.appId
          && !(c.teamId === options.devTarget!.teamId && c.channelId === options.devTarget!.channelId)
          && (!channelId || c.channelId === channelId));
      } catch (error) {
        // A failed authority lookup is retryable. A valid empty response means the exact channel is unavailable.
        if (channelId) throw error;
        console.warn("[slack-owner] Agent channel verification unavailable", error instanceof Error ? error.name : "UnknownError");
        return [];
      }
    },
    async discoverThreadEnrollment(input: SlackThreadContextEnrollmentRequest, signal: AbortSignal) {
      try {
        const request = SlackThreadContextEnrollmentRequestSchema.parse(input);
        // The isolated zero-traffic revision may cold-start on the first lookup.
        const response = await rpc("/internal/slack/thread-context/enrollment", request, signal, options.devTarget ? 25_000 : undefined);
        const parsed = SlackThreadContextEnrollmentResponseSchema.safeParse(response.body);
        return response.status === 200 && parsed.success ? parsed.data : { available: false as const };
      } catch (error) {
        if (!signal.aborted) console.warn("[slack-owner] enrollment unavailable", error instanceof Error ? error.name : "UnknownError");
        return { available: false as const };
      }
    },
    async readEnrolledContext(input: SlackEnrolledContextRequest, signal: AbortSignal) {
      const request = SlackEnrolledContextRequestSchema.parse(input);
      const response = await rpc("/internal/slack/context", request, signal, 10_000, 24 * 1024);
      const parsed = SlackEnrolledContextResponseSchema.safeParse(response.body);
      if (response.status !== 200 || !parsed.success || !parsed.data.available) throw new Error("Slack read unavailable");
      return parsed.data;
    },
    async readSummaryThread(access: SummaryAccess, signal: AbortSignal) {
      const response = await rpc("/internal/slack/context", access, signal, 30_000, 24*1024);
      const parsed = SlackPrivateThreadContextResponseSchema.safeParse(response.body);
      return response.status === 200 && parsed.success && parsed.data.available ? parsed.data : null;
    },
    async readThreadContextAccess(access: SlackThreadContextAccess, signal: AbortSignal) {
      try {
        const response = await rpc("/internal/slack/thread-context/access", { ...access, includeChannelMetadata: true }, signal);
        const parsed = SlackThreadContextAccessResponseSchema.safeParse(response.body);
        return response.status === 200 && parsed.success ? parsed.data : { allowed: false as const };
      } catch (error) {
        if (!signal.aborted) console.warn("[slack-owner] context access unavailable", error instanceof Error ? error.name : "UnknownError");
        return { allowed: false as const };
      }
    },
    async canReadThreadContext(access: SlackThreadContextAccess, signal: AbortSignal) {
      try {
        const response = await rpc("/internal/slack/thread-context/access", access, signal);
        return response.status === 200 && z.object({ allowed: z.literal(true) }).strict().safeParse(response.body).success;
      } catch (error) {
        if (!signal.aborted) console.warn("[slack-owner] context access unavailable", error instanceof Error ? error.name : "UnknownError");
        return false;
      }
    },
    async react(envelope:SlackBridgeEnvelope){
      try {
        const result=await rpc("/internal/slack/reactions",{teamId:envelope.event.teamId,eventId:envelope.event.eventId});
        if(result.status<200 || result.status>=300 || !z.object({reacted:z.literal(true)}).strict().safeParse(result.body).success)console.warn("[slack-owner] progress reaction unavailable");
      } catch(error:unknown) {
        console.warn("[slack-owner] progress reaction unavailable",error instanceof Error?error.name:"UnknownError");
      }
    },
    async readThread(envelope:SlackBridgeEnvelope){
      try{
        const result=await rpc("/internal/slack/context",{teamId:envelope.event.teamId,eventId:envelope.event.eventId});
        const parsed=ContextSchema.safeParse(result.body);
        return result.status>=200&&result.status<300&&parsed.success?{messages:parsed.data.messages,partial:parsed.data.partial}:null;
      }catch(error:unknown){console.warn("[slack-owner] thread context unavailable",error instanceof Error?error.name:"UnknownError");return null;}
    },
    async sendReply(input:{envelope:SlackBridgeEnvelope;text:string}):Promise<{status:"sent";messageTs:string}|{status:"retryable";reason?:"receipt_not_ready";retryAfterMs?:number}|{status:"uncertain"}>{
      try{
        const result=await rpc("/internal/slack/replies",{teamId:input.envelope.event.teamId,eventId:input.envelope.event.eventId,text:input.text});
        const sent=z.object({sent:z.literal(true),messageTs:z.string().regex(/^\d{1,16}\.\d{1,8}$/)}).strict().safeParse(result.body);
        if(result.status>=200&&result.status<300&&sent.success)return{status:"sent",messageTs:sent.data.messageTs};
        const notReady=result.status===503 && z.object({error:z.literal("Delivery not ready"),code:z.literal("receipt_not_ready")}).strict().safeParse(result.body).success;
        if(notReady)return{status:"retryable",reason:"receipt_not_ready"};
        const notSent=result.status===503 && z.object({error:z.literal("Try again later"),code:z.literal("reply_not_sent")}).strict().safeParse(result.body).success;
        if(notSent)return{status:"retryable"};
        return result.status===429?{status:"retryable",retryAfterMs:result.retryAfterMs}:{status:"uncertain"};
      }catch(error:unknown){console.warn("[slack-owner] delivery outcome unknown",error instanceof Error?error.name:"UnknownError");return{status:"uncertain"};}
    },
  };
}


/** Read the pilot enrollment for its original private Chat. This grants no route or rule authority. */
export function createPilotChannelReader(platform: SlackBotPlatform,
  discover = createSlackOwnerClient(platform).discoverThreadEnrollment): NonNullable<BotResourceGrantProviders["readPilotChannel"]> {
  return async target => {
    const pilot = platform.devTarget;
    if (!pilot || platform.runtimeSlot !== "dev" || platform.machineId !== pilot.machineId || platform.handle !== pilot.handle
      || target.ownerId !== pilot.ownerId || target.agentId !== pilot.botId || target.chatId !== pilot.chatId) return;
    const enrolled = await discover({ ownerId: target.ownerId, botId: target.agentId, chatId: target.chatId,
      runtimeId: pilot.machineId }, AbortSignal.timeout(7500));
    if (enrolled.available && enrolled.scope === "channel" && enrolled.appId === pilot.appId && enrolled.teamId === pilot.teamId
      && enrolled.channelId === pilot.channelId && enrolled.channel.id === pilot.channelId && enrolled.channel.name === "tech"
      && enrolled.access.ownerId === target.ownerId && enrolled.access.botId === target.agentId && enrolled.access.chatId === target.chatId
      && enrolled.access.runtimeId === pilot.machineId) return {name:"tech"};
  };
}
