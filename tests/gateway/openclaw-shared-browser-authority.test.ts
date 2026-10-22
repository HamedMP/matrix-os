import { expect, it, vi } from "vitest";
import { registerOpenClawSharedBrowserRelay } from "../../packages/gateway/src/chat/openclaw-shared-browser-relay.js";
import type { OpenClawRpcClient } from "../../packages/gateway/src/agent-config/openclaw-rpc.js";

function api() {
  const methods = new Map<string, (input: { params: unknown; respond(ok: boolean, value?: unknown): void }) => Promise<void>>();
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
  const services: Array<{ start(): void; stop(): Promise<void> }> = [];
  const cleanups: Array<() => Promise<void>> = [];
  let factory: (context: unknown) => { execute(id: string, raw: unknown, signal?: AbortSignal): Promise<unknown> };
  return { methods, hooks, services, cleanups, tool: (context: unknown) => factory(context), value: {
    registerGatewayMethod: (name: string, handler: never) => methods.set(name, handler),
    registerTool: (value: typeof factory) => { factory = value; },
    on: (name: string, handler: never) => hooks.set(name, handler),
    registerService: (service: { start(): void; stop(): Promise<void> }) => services.push(service),
    lifecycle: { registerRuntimeLifecycle: (value: { cleanup(): Promise<void> }) => cleanups.push(value.cleanup) },
  } };
}
it("uses one authenticated RPC authority when native hooks and tools select another same-ID registration", async () => {
  const a = api(), b = api();
  const rpc: OpenClawRpcClient = { close: vi.fn(async () => {}), call: vi.fn(async (method, params) => {
    const handler = a.methods.get(method);
    if (!handler) throw new Error("Method unavailable");
    let result: unknown; let accepted = false;
    await handler({ params, respond(ok, value) { accepted = ok; result = value; } });
    if (!accepted) throw new Error("RPC refused");
    return result;
  }) };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
  const closeA = registerOpenClawSharedBrowserRelay(a.value as never, { gatewayPort: 4000, rpc, fetcher });
  const closeB = registerOpenClawSharedBrowserRelay(b.value as never, { gatewayPort: 4000, rpc, fetcher });
  try {
    let bound: unknown;
    await a.methods.get("matrix.browser.bind")!({ params: { runId: "run_synthetic", sessionKey: "agent:main:synthetic", token: "a".repeat(43), expiresAt: Date.now() + 60000 }, respond(ok) { bound = ok; } });
    expect(bound).toBe(true);
    const context = { runId: "run_synthetic", sessionKey: "agent:main:synthetic", toolCallId: "call_synthetic" };
    const stamped = await b.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "status" } }, context) as { params: unknown };
    expect(stamped).toMatchObject({ params: { action: "status" } });
    await expect(b.tool(context).execute(context.toolCallId, stamped.params)).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const requests = JSON.stringify(vi.mocked(rpc.call).mock.calls);
    expect(requests).not.toContain("a".repeat(43));
  } finally { await closeA(); await closeB(); }
});

const context = { runId: "run_bound", sessionKey: "agent:main:bound", toolCallId: "call_bound" };
function pair(fetcher: typeof fetch, holdExecute?: Promise<void>) {
  const a = api(), b = api(); const requests: Array<{ method: string; params: any }> = [];
  const createClient = (): OpenClawRpcClient => ({ close: vi.fn(async () => {}), call: vi.fn((method, params, signal) => {
    requests.push({ method, params });
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new Error("IPC aborted"));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      void (async () => {
        if (method === "matrix.browser.execute" && holdExecute) await holdExecute;
        const handler = a.methods.get(method); if (!handler) throw new Error("Missing method");
        let ok = false; let result: unknown;
        await handler({ params, respond(accepted, value) { ok = accepted; result = value; } });
        if (!ok) throw new Error("RPC refused"); return result;
      })().then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }) });
  const rpcA = createClient(), rpcB = createClient();
  const closeA = registerOpenClawSharedBrowserRelay(a.value as never, { gatewayPort: 4000, rpc: rpcA, fetcher });
  const closeB = registerOpenClawSharedBrowserRelay(b.value as never, { gatewayPort: 4000, rpc: rpcB, fetcher });
  const bind = async () => { let ok = false; await a.methods.get("matrix.browser.bind")!({ params: { runId: context.runId, sessionKey: context.sessionKey, token: "a".repeat(43), expiresAt: Date.now() + 60000 }, respond(value) { ok = value; } }); expect(ok).toBe(true); };
  const before = async (name = "shared_browser") => await b.hooks.get("before_tool_call")!({ toolName: name, params: { action: "snapshot" } }, { ...context, agentId: "native_extra_identity" }) as { params?: unknown; block?: boolean };
  return { a, b, rpcA, rpcB, requests, bind, before, closeA, closeB };
}
it("retiring the hook registration closes only its IPC client and preserves authority A", async () => {
  const p = pair(async () => Response.json({ success: true }));
  try {
    await p.bind(); await p.b.cleanups[0]!(); expect(p.rpcB.close).toHaveBeenCalledTimes(1);
    let revoked: unknown; await p.a.methods.get("matrix.browser.revoke")!({ params: { runId: context.runId }, respond(ok) { revoked = ok; } }); expect(revoked).toBe(true);
    expect(p.rpcA.close).not.toHaveBeenCalled();
  } finally { await p.closeA(); await p.closeB(); }
});
it("settles the authoritative plugin request before cancellation acknowledgement and retains native bypass quarantine", async () => {
  const started = Promise.withResolvers<void>(); let aborted = false; let calls = 0;
  const p = pair(async (_url, init) => {
    if (++calls === 1) return Response.json({ success: true });
    started.resolve(); return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("Authoritative fetch aborted")); }, { once: true }));
  });
  try {
    await p.bind(); const stamped = await p.before(); const cancel = new AbortController();
    const action = p.b.tool(context).execute(context.toolCallId, stamped.params, cancel.signal); const rejected = expect(action).rejects.toThrow();
    await started.promise; cancel.abort(); await rejected;
    expect(aborted).toBe(true); expect(p.requests.some(r => r.method === "matrix.browser.cancel")).toBe(true);
    expect(await p.before("exec")).toMatchObject({ block: true });
  } finally { await p.closeA(); await p.closeB(); }
});
it("cancels a ticket before delayed invocation without allowing it to execute later", async () => {
  const delayed = Promise.withResolvers<void>(); let fetches = 0;
  const p = pair(async () => { fetches++; return Response.json({ success: true }); }, delayed.promise);
  try {
    await p.bind(); const stamped = await p.before(); const controller = new AbortController();
    const action = p.b.tool(context).execute(context.toolCallId, stamped.params, controller.signal); const rejected = expect(action).rejects.toThrow();
    await vi.waitFor(() => expect(p.requests.some(r => r.method === "matrix.browser.execute")).toBe(true));
    controller.abort(); await rejected; delayed.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetches).toBe(1); expect(await p.before("browser")).toMatchObject({ block: true });
  } finally { delayed.resolve(); await p.closeA(); await p.closeB(); }
});
it("a wrong cancel nonce cannot abort a different in-flight action", async () => {
  const started = Promise.withResolvers<void>(); let aborted = false; let calls = 0;
  const p = pair(async (_url, init) => {
    if (++calls === 1) return Response.json({ success: true });
    started.resolve(); return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("Stopped")); }, { once: true }));
  });
  try {
    await p.bind(); const stamped = await p.before(); const controller = new AbortController(); const action = p.b.tool(context).execute(context.toolCallId, stamped.params, controller.signal); const rejected = expect(action).rejects.toThrow();
    await started.promise; const sent = p.requests.find(r => r.method === "matrix.browser.execute")!.params; const { action: _action, ...cancel } = sent;
    await expect(p.rpcB.call("matrix.browser.cancel", { ...cancel, callId: "f".repeat(32) }, AbortSignal.timeout(1000))).rejects.toThrow(); expect(aborted).toBe(false);
    controller.abort(); await rejected; expect(aborted).toBe(true);
  } finally { await p.closeA(); await p.closeB(); }
});
it("the captured startup service drains A even when the composed gateway-stop hook belongs to B", async () => {
  const p = pair(async () => Response.json({ success: true }));
  try {
    p.a.services[0]!.start(); await p.bind(); await p.b.hooks.get("gateway_stop")!({}, {});
    expect(p.rpcA.close).not.toHaveBeenCalled(); await p.a.services[0]!.stop(); await p.a.services[0]!.stop();
    expect(p.rpcA.close).toHaveBeenCalledTimes(1);
    const result = await p.rpcA.call("matrix.browser.before", { context, event: { toolName: "shared_browser", params: { action: "status" } } }, AbortSignal.timeout(1000));
    expect(result).toMatchObject({ kind: "block" });
  } finally { await p.closeA(); await p.closeB(); }
});
it("rejects a wrong nonce before invocation without consuming the valid queued ticket", async () => {
  let calls = 0; const p = pair(async () => { calls++; return Response.json({ success: true }); });
  try {
    await p.bind(); const stamped = await p.before();
    const ticketId = (stamped.params as Record<string, string>).__matrix_browser_ticket;
    await expect(p.rpcB.call("matrix.browser.cancel", { sessionKey: context.sessionKey, toolCallId: context.toolCallId, ticketId, callId: "f".repeat(32) }, AbortSignal.timeout(1000))).rejects.toThrow();
    await expect(p.b.tool(context).execute(context.toolCallId, stamped.params)).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(calls).toBe(2);
  } finally { await p.closeA(); await p.closeB(); }
});
it.each([undefined, { settled: true, foreign: true }])("never treats an unconfirmed cancellation as a successful later retirement (%j)", async (cancelResponse) => {
  const started = Promise.withResolvers<void>(); let calls = 0;
  const p = pair(async (_url, init) => {
    if (++calls === 1) return Response.json({ success: true });
    started.resolve(); return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }));
  });
  const original = vi.mocked(p.rpcB.call).getMockImplementation()!;
  vi.mocked(p.rpcB.call).mockImplementation((method, ...args) => method === "matrix.browser.cancel" ? cancelResponse === undefined ? Promise.reject(new Error("IPC unavailable")) : Promise.resolve(cancelResponse) : original(method, ...args));
  try {
    await p.bind(); const stamped = await p.before(); const cancel = new AbortController();
    const action = p.b.tool(context).execute(context.toolCallId, stamped.params, cancel.signal); const rejected = expect(action).rejects.toThrow("Browser cleanup unavailable");
    await started.promise; cancel.abort(); await rejected;
    await expect(p.closeB()).rejects.toThrow("Browser cleanup unavailable");
    await expect(p.closeB()).rejects.toThrow("Browser cleanup unavailable");
  } finally { await p.closeA(); await expect(p.closeB()).rejects.toThrow(); }
});
it("shares the bounded ticket cap across registrations and cannot replay a consumed ticket", async () => {
  const p = pair(async () => Response.json({ success: true }));
  try {
    await p.bind(); const first = await p.before();
    for (let index = 1; index < 128; index++) expect(await p.before()).toHaveProperty("params");
    expect(await p.before()).toMatchObject({ block: true });
    await p.b.tool(context).execute(context.toolCallId, first.params);
    await expect(p.b.tool(context).execute(context.toolCallId, first.params)).rejects.toThrow();
    expect(await p.before()).toHaveProperty("params");
  } finally { await p.closeA(); await p.closeB(); }
});
