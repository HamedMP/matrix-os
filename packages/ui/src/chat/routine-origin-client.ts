import { BotInteractionIdSchema, CanonicalChatIdSchema, ResolveBotInteractionRequestSchema, ResolveBotInteractionResponseSchema, RoutineChatOriginViewSchema, type BotInteraction, type ResolveBotInteractionRequest, type ResolveBotInteractionResponse, type RoutineChatOriginView } from "@matrix-os/contracts";
import { safeHttpStatus } from "../chat-agents/safe-http-status.js";
export type RoutineOriginDecision = Extract<ResolveBotInteractionRequest, {kind:"approval"}>;
export type RoutineOriginRequestOptions = { signal?: AbortSignal; timeoutMs?: number };
const DECISION_RESPONSE_TIMEOUT_MS = 30_000;
export interface RoutineOriginClient {
  get(chatId:string,signal?:AbortSignal):Promise<RoutineChatOriginView>;
  resolve(chatId:string,interactionId:string,input:RoutineOriginDecision,signal?:AbortSignal):Promise<ResolveBotInteractionResponse>;
}
/** These endpoints use a strict purpose-specific wire contract. Leave all caller query parameters intact for Gateway validation. */
export function isRoutineOriginPath(path: string): boolean {
  return /^\/api\/chats\/[^/?]+\/routine-origin(?:[/?]|$)/.test(path);
}
export const ROUTINE_ORIGIN_ERROR="Scheduled task status could not be confirmed. Refresh before responding again.";
/** The host transport retains authentication, proof signing and its bounded timeout. */
export function createRoutineOriginClient(request:(path:string,method:"GET"|"POST",body?:unknown,options?:RoutineOriginRequestOptions)=>Promise<unknown>):RoutineOriginClient {
  const path=(id:string)=>`/api/chats/${encodeURIComponent(CanonicalChatIdSchema.parse(id))}/routine-origin`;
  let legacyRead = false;
  return {
    get: async (id, signal) => {
      const endpoint = path(id);
      if (!legacyRead) {
        try {
          return RoutineChatOriginViewSchema.parse(await request(`${endpoint}?timeline=1`, "GET", undefined, { signal }));
        } catch (error: unknown) {
          // Older hosts reject any query parameter on this GET. Only retry the read.
          if (signal?.aborted || safeHttpStatus(error) !== 400) throw error;
          legacyRead = true;
        }
      }
      return RoutineChatOriginViewSchema.parse(await request(endpoint, "GET", undefined, { signal }));
    },
    resolve:async(id,interactionId,input,signal)=>{
      const body=ResolveBotInteractionRequestSchema.parse(input);
      if(body.kind!=="approval") throw new Error(ROUTINE_ORIGIN_ERROR);
      const response=ResolveBotInteractionResponseSchema.parse(await request(`${path(id)}/${encodeURIComponent(BotInteractionIdSchema.parse(interactionId))}/resolve`,"POST",body,{signal,timeoutMs:DECISION_RESPONSE_TIMEOUT_MS}));
      if(response.interaction.interactionId!==interactionId)throw new Error(ROUTINE_ORIGIN_ERROR);
      return response;
    },
  };
}
export function isRoutineOriginApproval(interaction:BotInteraction):boolean {
  return interaction.kind==="approval"&&interaction.payload?.kind==="approval"&&interaction.payload.tool==="routine.activate";
}
