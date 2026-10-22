import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { nativeBrowserExecution } from "../../packages/gateway/src/chat/native-browser-execution-context.js";
it("carries canonical owner authority into delayed durable initial and successor dispatch only",async()=>{
 const home=await mkdtemp('/tmp/mx-browser-chat-');const live=new Set<string>();const seen:Array<string|undefined>=[];const policies:unknown[]=[];
 const broker={openRun:(_binding,signal,policy)=>{policies.push(policy);const token=randomBytes(32).toString('base64url');live.add(token);signal.addEventListener('abort',()=>live.delete(token));return{token,expiresAt:1,close:async()=>{live.delete(token)}};},resolveCapability:token=>live.has(token)?{}:null} as never;
 const finish=async({principal,thread,turn,now,nextEventId})=>{await Promise.resolve();seen.push(nativeBrowserExecution(principal.userId)?.token);return{outcome:'completed',events:turn?[]:[{type:'thread.completed',eventId:nextEventId(),threadId:thread.id,occurredAt:now().toISOString(),outcome:'completed'}],resumeState:{conversationId:'native_owner_thread'}};};
 const threads=createCodingAgentThreadStore({homePath:home,providers:[{providerId:'codex',initialRunExecution:'background',startThread:finish,resumeTurn:finish}],relationValidator:{validateCreate:async()=>{},validateThread:async()=>{}}});
 const adapter=createCanonicalCodingChatProviderAdapter({providerId:'codex',threads,sharedBrowser:broker,gatewayPort:4000});
 const base={owner:{type:'personal' as const,ownerId:'owner_browser'},chatId:'chat_browser',turnId:'cturn_browser',runId:'run_browser',prompt:'Synthetic',parts:[{type:'text' as const,text:'Synthetic'}],selection:{instanceId:'codex_default',model:'gpt-5.6-sol'},interactionMode:'default',permissionMode:'full_access',signal:new AbortController().signal};
 try{let state;for await(const e of adapter.start!(base)){if(e.type==='state.updated')state=e.state;}expect(seen[0]).toHaveLength(43);expect(live.size).toBe(0);
  for await(const _ of adapter.resume!({...base,runId:'run_second',resumeState:state})){}
  expect(seen[1]).toHaveLength(43);expect(seen[1]).not.toBe(seen[0]);expect(live.size).toBe(0);
  for await(const _ of adapter.resume!({...base,runId:'run_restricted',permissionMode:'supervised',resumeState:state})){}
  expect(seen[2]).toHaveLength(43);expect(policies[2]).toMatchObject({mode:"supervised",authorizeAction:expect.any(Function)});expect(live.size).toBe(0);
 }finally{await rm(home,{recursive:true,force:true});}
});

it.each(["start", "resume"])("releases browser admission when %s event-sink registration is rejected", async (phase) => {
  const live = new Set<string>();
  const close = vi.fn(async (token: string) => { live.delete(token); });
  const broker = {
    openRun: (_binding, signal) => {
      const token = randomBytes(32).toString("base64url"); live.add(token);
      signal.addEventListener("abort", () => live.delete(token));
      return { token, expiresAt: 1, close: () => close(token) };
    },
    resolveCapability: token => live.has(token) ? {} : null,
  } as never;
  const threads = {
    registerEventSink: () => { throw new Error("Synthetic sink capacity exceeded"); },
  } as never;
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads, sharedBrowser: broker, gatewayPort: 4000 });
  const input = { owner: { type: "personal" as const, ownerId: "owner_sink_rejected" }, chatId: "chat_sink_rejected",
    turnId: "cturn_sink_rejected", runId: `run_sink_rejected_${phase}`, prompt: "Synthetic",
    parts: [{ type: "text" as const, text: "Synthetic" }], selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal };
  const execution = phase === "start" ? adapter.start!(input) : adapter.resume!({ ...input,
    resumeState: { conversationId: "thread_sink_rejected", runId: "run_previous" } });
  await expect(execution.next()).rejects.toThrow("Synthetic sink capacity exceeded");
  expect(close).toHaveBeenCalledOnce();
  expect(live.size).toBe(0);
  await expect(adapter.start!(input).next()).rejects.toThrow("Synthetic sink capacity exceeded");
  expect(close).toHaveBeenCalledTimes(2);
});


it.each(["initial", "successor"])("retains an unconfirmed physical cleanup through durable %s failure projection", async (phase) => {
  const home = await mkdtemp("/tmp/mx-browser-unconfirmed-");
  const live = new Set<string>();
  const leaseClose = vi.fn(async (token: string) => { live.delete(token); });
  const broker = {
    openRun: (_binding, signal) => {
      const token = randomBytes(32).toString("base64url");
      live.add(token);
      signal.addEventListener("abort", () => live.delete(token));
      return { token, expiresAt: 1, close: () => leaseClose(token) };
    },
    resolveCapability: token => live.has(token) ? {} : null,
  } as never;
  const { prepareCodexBrowser } = await import("../../packages/gateway/src/coding-agents/codex-browser-bootstrap-client.js");
  const cleanupUnconfirmed = vi.fn();
  const bootstrapFailure = async ({ principal }) => {
    await prepareCodexBrowser({
      ownerId: principal.userId, sessionId: "sess_unconfirmed", browser: nativeBrowserExecution(principal.userId)!,
      control: { prepareBrowser: async () => { throw new Error("Synthetic lost acknowledgement"); } } as never,
      runtime: { stopSession: async () => ({ ok: false }) } as never,
      signal: new AbortController().signal,
    });
    throw new Error("Unreachable synthetic bootstrap");
  };
  const complete = async ({ thread, now, nextEventId }) => ({
    events: [{ type: "thread.completed", eventId: nextEventId(), threadId: thread.id,
      occurredAt: now().toISOString(), outcome: "completed" }],
    resumeState: { conversationId: "native_unconfirmed_thread" },
  });
  const threads = createCodingAgentThreadStore({ homePath: home,
    providers: [{ providerId: "codex", initialRunExecution: "background",
      startThread: phase === "initial" ? bootstrapFailure : complete, resumeTurn: bootstrapFailure }],
    relationValidator: { validateCreate: async () => {}, validateThread: async () => {} },
  });
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads, sharedBrowser: broker, gatewayPort: 4000 });
  const input = { owner: { type: "personal" as const, ownerId: "owner_unconfirmed" }, chatId: "chat_unconfirmed",
    turnId: "cturn_unconfirmed", runId: "run_unconfirmed", prompt: "Synthetic", parts: [{ type: "text" as const, text: "Synthetic" }],
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "full_access",
    signal: new AbortController().signal, onCleanupUnconfirmed: cleanupUnconfirmed,
  };
  try {
    let state;
    if (phase === "successor") for await (const event of adapter.start!({ ...input, runId: "run_initial_success" })) {
      if (event.type === "state.updated") state = event.state;
    }
    const projected: Array<{ type: string; outcome?: string }> = [];
    await expect((async () => {
      const execution = phase === "initial" ? adapter.start!(input) : adapter.resume!({ ...input, resumeState: state });
      for await (const event of execution) projected.push(event);
    })()).rejects.toThrow("Browser cleanup unconfirmed");
    expect(projected).toContainEqual(expect.objectContaining({ type: "run.completed", outcome: "failed" }));
    expect(cleanupUnconfirmed).toHaveBeenCalledOnce();
    expect(live.size).toBe(0);
    expect(leaseClose).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
    await expect(adapter.start!(input).next()).rejects.toThrow("Browser run unavailable");
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("keeps cancellation admission until a delayed native bootstrap stop has settled", async () => {
  const home = await mkdtemp("/tmp/mx-browser-cancel-race-");
  const live = new Set<string>();
  const broker = {
    openRun: (_binding, signal) => {
      const token = randomBytes(32).toString("base64url"); live.add(token);
      signal.addEventListener("abort", () => live.delete(token));
      return { token, expiresAt: 1, close: async () => { live.delete(token); } };
    }, resolveCapability: token => live.has(token) ? {} : null,
  } as never;
  const { prepareCodexBrowser } = await import("../../packages/gateway/src/coding-agents/codex-browser-bootstrap-client.js");
  let releaseStop!: () => void;
  const stopSession = vi.fn(() => new Promise<{ ok: false }>(resolve => { releaseStop = () => resolve({ ok: false }); }));
  const prepareBrowser = vi.fn(({ signal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Synthetic aborted bootstrap")), { once: true });
  }));
  const threads = createCodingAgentThreadStore({ homePath: home,
    providers: [{ providerId: "codex", initialRunExecution: "background", startThread: async ({ principal, signal }) => {
      await prepareCodexBrowser({ ownerId: principal.userId, sessionId: "sess_cancel_race",
        browser: nativeBrowserExecution(principal.userId)!, control: { prepareBrowser } as never,
        runtime: { stopSession } as never, signal: signal!,
      });
      return [];
    }, abortThread: async ({ thread, now, nextEventId }) => [{ type: "thread.completed", eventId: nextEventId(),
      threadId: thread.id, occurredAt: now().toISOString(), outcome: "aborted" }] }], relationValidator: { validateCreate: async () => {}, validateThread: async () => {} },
  });
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads, sharedBrowser: broker, gatewayPort: 4000 });
  const onCleanupUnconfirmed = vi.fn();
  const input = { owner: { type: "personal" as const, ownerId: "owner_cancel_race" }, chatId: "chat_cancel_race",
    turnId: "cturn_cancel_race", runId: "run_cancel_race", prompt: "Synthetic", parts: [{ type: "text" as const, text: "Synthetic" }],
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "default", permissionMode: "full_access",
    signal: new AbortController().signal, onCleanupUnconfirmed,
  };
  let state, runSettled = false, cancelSettled = false;
  const running = (async () => { for await (const event of adapter.start!(input)) if (event.type === "state.updated") state = event.state; })();
  const runResult = running.then(() => { runSettled = true; return undefined; }, error => { runSettled = true; return error; });
  try {
    await vi.waitFor(() => { expect(state).toBeDefined(); expect(prepareBrowser).toHaveBeenCalledOnce(); });
    const cancellation = adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId, state });
    const cancelResult = cancellation.then(() => { cancelSettled = true; return undefined; }, error => { cancelSettled = true; return error; });
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(live.size).toBe(0);
    expect(cancelSettled).toBe(false); expect(runSettled).toBe(false);
    await expect(adapter.start!(input).next()).rejects.toThrow("Browser run unavailable");
    releaseStop();
    expect(await cancelResult).toMatchObject({ message: "Browser cleanup unconfirmed" });
    expect(await runResult).toMatchObject({ message: "Browser cleanup unconfirmed" });
    expect(onCleanupUnconfirmed).toHaveBeenCalledOnce();
    await expect(adapter.start!(input).next()).rejects.toThrow("Browser run unavailable");
  } finally {
    releaseStop?.(); await runResult; await rm(home, { recursive: true, force: true });
  }
});
