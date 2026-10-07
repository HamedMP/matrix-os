import { BotProviderConnectionsSchema, BotProviderAuthorizationRequestSchema, BotExecutionBindingSchema, BotExecutionBindingRequestSchema, ChatAgentIdSchema } from "@matrix-os/contracts";
import type { z } from "zod/v4";

export type BotProviderConnections = z.infer<typeof BotProviderConnectionsSchema>;
export type BotExecutionBinding = z.infer<typeof BotExecutionBindingSchema>;
export type BotExecutionBindingRequest = z.infer<typeof BotExecutionBindingRequestSchema>;
export type BotProviderAuthorizationRequest = z.infer<typeof BotProviderAuthorizationRequestSchema>;
export interface BotConnectionClient {
 refreshConnections?(): void;
 connections(signal?: AbortSignal): Promise<BotProviderConnections>;
 authorizeConnection(id: string, input: BotProviderAuthorizationRequest, signal?: AbortSignal): Promise<BotProviderConnections>;
 execution(agentId: string, signal?: AbortSignal): Promise<BotExecutionBinding>;
 configureExecution(agentId: string, input: BotExecutionBindingRequest, signal?: AbortSignal): Promise<BotExecutionBinding>;
}

/** Shared owner/Computer-bound transports carry nonsecret grants and bindings only. */
export function createBotConnectionClient(request: (path: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal) => Promise<unknown>): BotConnectionClient {
 async function call<T>(path: string, method: "GET" | "POST", schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
   try {
     if (signal?.aborted) throw new Error("cancelled");
     const value = await request(path, method, body, signal);
     if (signal?.aborted) throw new Error("cancelled");
     return schema.parse(value);
   } catch (error) {
     console.warn("[bot-connections] Request unavailable:", error instanceof Error ? error.name : typeof error);
     throw new Error("Bot connections are unavailable. Check again.");
   }
 }
 let cached: {value:BotProviderConnections; until:number} | null = null;
 let cacheEpoch=0;
 let pending: Promise<BotProviderConnections> | null = null;
 const connectionPath = (id: string) => {
   if (id !== "matrix_chatgpt_plan" && id !== "claude_code_tasks") throw new Error("Bot connections are unavailable. Check again.");
   return `/api/bot-connections/${id}/authorization`;
 };
 const bindingPath = (id: string) => `/api/chat-agents/${encodeURIComponent(ChatAgentIdSchema.parse(id))}/execution`;
 return {
   refreshConnections: () => {cacheEpoch+=1; cached=null; pending=null;},
   connections: async signal => {
     if (signal?.aborted) throw new Error("Bot connections are unavailable. Check again.");
     if (!cached || Date.now() >= cached.until) {
       if (!pending) {const epoch=cacheEpoch; const task:Promise<BotProviderConnections> = call("/api/bot-connections?includeChatgptPlan=true", "GET", BotProviderConnectionsSchema).then(value => {
         if(epoch===cacheEpoch) cached={value,until:Date.now()+15_000}; return value;
       }).finally(() => {if(pending===task) pending=null;}); pending=task;}
       const value = await pending;
       if (signal?.aborted) throw new Error("Bot connections are unavailable. Check again.");
       return value;
     }
     return cached.value;
   },
   authorizeConnection: async (id, input, signal) => {
     cacheEpoch+=1; cached=null;
     const value=await call(connectionPath(id), "POST", BotProviderConnectionsSchema, BotProviderAuthorizationRequestSchema.parse(input), signal);
     cached={value,until:Date.now()+15_000}; return value;
   },
   execution: (id, signal) => call(bindingPath(id), "GET", BotExecutionBindingSchema, undefined, signal),
   configureExecution: (id, input, signal) => call(bindingPath(id), "POST", BotExecutionBindingSchema, BotExecutionBindingRequestSchema.parse(input), signal),
 };
}
