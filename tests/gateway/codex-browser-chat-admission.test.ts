import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { nativeBrowserExecution } from "../../packages/gateway/src/chat/native-browser-execution-context.js";
it("carries canonical owner authority into delayed durable initial and successor dispatch only",async()=>{
 const home=await mkdtemp('/tmp/mx-browser-chat-');const live=new Set<string>();const seen:Array<string|undefined>=[];
 const broker={openRun:(_binding,signal)=>{const token=randomBytes(32).toString('base64url');live.add(token);signal.addEventListener('abort',()=>live.delete(token));return{token,expiresAt:1,close:async()=>{live.delete(token)}};},resolveCapability:token=>live.has(token)?{}:null} as never;
 const finish=async({principal,thread,turn,now,nextEventId})=>{await Promise.resolve();seen.push(nativeBrowserExecution(principal.userId)?.token);return{outcome:'completed',events:turn?[]:[{type:'thread.completed',eventId:nextEventId(),threadId:thread.id,occurredAt:now().toISOString(),outcome:'completed'}],resumeState:{conversationId:'native_owner_thread'}};};
 const threads=createCodingAgentThreadStore({homePath:home,providers:[{providerId:'codex',initialRunExecution:'background',startThread:finish,resumeTurn:finish}],relationValidator:{validateCreate:async()=>{},validateThread:async()=>{}}});
 const adapter=createCanonicalCodingChatProviderAdapter({providerId:'codex',threads,sharedBrowser:broker,gatewayPort:4000});
 const base={owner:{type:'personal' as const,ownerId:'owner_browser'},chatId:'chat_browser',turnId:'cturn_browser',runId:'run_browser',prompt:'Synthetic',parts:[{type:'text' as const,text:'Synthetic'}],selection:{instanceId:'codex_default',model:'gpt-5.6-sol'},interactionMode:'default',permissionMode:'full_access',signal:new AbortController().signal};
 try{let state;for await(const e of adapter.start!(base)){if(e.type==='state.updated')state=e.state;}expect(seen[0]).toHaveLength(43);expect(live.size).toBe(0);
  for await(const _ of adapter.resume!({...base,runId:'run_second',resumeState:state})){}
  expect(seen[1]).toHaveLength(43);expect(seen[1]).not.toBe(seen[0]);expect(live.size).toBe(0);
  for await(const _ of adapter.resume!({...base,runId:'run_restricted',permissionMode:'supervised',resumeState:state})){}
  expect(seen[2]).toBeUndefined();expect(live.size).toBe(0);
 }finally{await rm(home,{recursive:true,force:true});}
});
