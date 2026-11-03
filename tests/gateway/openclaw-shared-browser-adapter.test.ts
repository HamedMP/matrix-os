import { expect, it, vi } from "vitest";
import { createOpenClawChatProviderAdapter } from "../../packages/gateway/src/chat/openclaw-provider-adapter.js";
import { registerOpenClawSharedBrowserPlugin } from "../../packages/gateway/src/chat/openclaw-shared-browser-plugin.js";
const input = { owner: { type: "personal" as const, ownerId: "owner_qa" }, chatId: "chat_qa", runId: "run_qa", turnId: "turn_qa", prompt: "Collect fixture invoices", parts: [{ type: "text" as const, text: "Collect fixture invoices" }],
  selection: { instanceId: "openclaw_default", model: "openai:gpt-5.4" }, interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal };
const collect = async (source: AsyncIterable<unknown>) => { const rows = []; for await (const row of source) rows.push(row); return rows; };
function setup(failBind = false, timeoutMs?: number) {
  const broker = { openRun: vi.fn(() => ({ token: "a".repeat(43), expiresAt: Date.now()+60000 })), closeRun: vi.fn(async () => undefined) };
  const rpc = { call: vi.fn(async (method: string, _args: unknown, _signal: unknown, options?: { onAccepted?: (value: unknown) => void; onDispatched?: () => void }) => {
    if (method === "matrix.browser.bind") { if (failBind) throw new Error("plugin unavailable"); return { bound: true }; }
    if (method === "matrix.browser.revoke") return { revoked: true };
    if (method === "agent") { options?.onDispatched?.(); options?.onAccepted?.({ runId: input.runId, sessionKey: (_args as { sessionKey: string }).sessionKey, status: "accepted" }); return { runId: input.runId, status: "ok" }; }
    if (method === "chat.abort") return { ok: true };
    throw new Error("unknown native method");
  }), subscribe: vi.fn(), close: vi.fn() };
  const adapter = createOpenClawChatProviderAdapter({ rpc: rpc as never, homePath: "/home/matrix", sharedBrowser: broker as never, ...(timeoutMs ? { timeoutMs } : {}) });
  return { broker, rpc, adapter };
}
it("binds trusted native run context before inference and revokes it on canonical completion", async () => {
  const { broker, rpc, adapter } = setup();
  const rows = await collect(adapter.start(input));
  expect(broker.openRun).toHaveBeenCalledWith({ ownerId: "owner_qa", chatId: "chat_qa", runId: "run_qa", harness: "openclaw" }, input.signal);
  expect(rpc.call.mock.calls.map(call => call[0])).toEqual(["matrix.browser.bind", "agent", "matrix.browser.revoke"]);
  expect(rows.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
  expect(broker.closeRun).toHaveBeenCalledWith(input.runId);
});

it("reclaims an acknowledged browser lease when cancellation aborts connection before native dispatch", async () => {
  const { rpc, adapter } = setup();
  const methods = new Map<string, (input: { params: unknown; respond(ok: boolean, result?: unknown): void }) => Promise<void>>();
  const stopPlugin = registerOpenClawSharedBrowserPlugin({ registerGatewayMethod: (name, handler) => methods.set(name, handler),
    registerTool: () => {}, on: () => {} }, { gatewayPort: 4000, fetcher: vi.fn<typeof fetch>(async () => Response.json({ success: true })) });
  const waiting = Promise.withResolvers<unknown>();
  let nativeSignal: AbortSignal | undefined, first = true;
  rpc.call.mockImplementation(async (method, args, signal, options) => {
    if (methods.has(method)) {
      let result: unknown;
      await methods.get(method)!({ params: args, respond(ok, value) { if (!ok) throw new Error("Binding refused"); result = value; } });
      return result;
    }
    if (method === "chat.abort") return { ok: true };
    if (method === "agent") {
      if (first) {
        first = false; nativeSignal = signal as AbortSignal;
        nativeSignal.addEventListener("abort", () => waiting.reject(new Error("Connection cancelled")), { once: true });
        return waiting.promise;
      }
      options?.onDispatched?.();
      const request = args as { idempotencyKey: string; sessionKey: string };
      options?.onAccepted?.({ runId: request.idempotencyKey, sessionKey: request.sessionKey, status: "accepted" });
      return { runId: request.idempotencyKey, status: "ok" };
    }
    throw new Error("Unexpected native method");
  });
  const running = collect(adapter.start(input));
  try {
    await vi.waitFor(() => expect(nativeSignal).toBeDefined());
    await adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId });
    expect(nativeSignal?.aborted).toBe(true);
    expect((await running).at(-1)).toMatchObject({ type: "run.completed", outcome: "aborted" });
    expect((await collect(adapter.start({ ...input, runId: "run_retry" }))).at(-1))
      .toMatchObject({ type: "run.completed", outcome: "completed" });
  } finally { waiting.reject(new Error("Diagnostic settled")); await running; stopPlugin(); }
});

it("retains an unknown native guard when sending throws after the dispatch boundary", async () => {
  const { rpc, adapter } = setup();
  const methods = new Map<string, (input: { params: unknown; respond(ok: boolean, result?: unknown): void }) => Promise<void>>();
  const stopPlugin = registerOpenClawSharedBrowserPlugin({ registerGatewayMethod: (name, handler) => methods.set(name, handler),
    registerTool: () => {}, on: () => {} }, { gatewayPort: 4000, fetcher: vi.fn<typeof fetch>(async () => Response.json({ success: true })) });
  rpc.call.mockImplementation(async (method, args, _signal, options) => {
    if (methods.has(method)) {
      let result: unknown;
      await methods.get(method)!({ params: args, respond(ok, value) { if (!ok) throw new Error("Binding refused"); result = value; } });
      return result;
    }
    if (method === "agent") { options?.onDispatched?.(); throw new Error("Ambiguous socket send failure"); }
    throw new Error("Unexpected native method");
  });
  try {
    expect((await collect(adapter.start(input))).at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    expect((await collect(adapter.start({ ...input, runId: "run_retry" }))).at(-1))
      .toMatchObject({ type: "run.completed", outcome: "failed" });
    expect(rpc.call.mock.calls.filter(call => call[0] === "agent")).toHaveLength(1);
  } finally { stopPlugin(); }
});
it("does not start inference when the fixed native browser plugin is unavailable", async () => {
  const { broker, rpc, adapter } = setup(true);
  const rows = await collect(adapter.start(input));
  expect(rpc.call.mock.calls.map(call => call[0])).not.toContain("agent");
  expect(rows.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  expect(broker.closeRun).toHaveBeenCalledWith(input.runId);
});
it("ignores browser scope on supervised or nonpersonal runs, never issuing a stronger capability", async () => {
  const { broker, rpc, adapter } = setup();
  await collect(adapter.start({ ...input, permissionMode: "supervised" }));
  expect(broker.openRun).not.toHaveBeenCalled(); expect(rpc.call.mock.calls.map(call => call[0])).not.toContain("matrix.browser.bind");
});
it("rejects cancellation from another owner or Chat without revoking the active browser", async () => {
  const { broker, rpc, adapter } = setup(); const native = Promise.withResolvers<unknown>();
  rpc.call.mockImplementationOnce(async () => ({ bound: true })).mockImplementationOnce(async () => native.promise);
  const iterator = adapter.start(input)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "state.updated" });
  await expect(adapter.cancel!({ owner: { type: "personal", ownerId: "other_owner" }, chatId: input.chatId, runId: input.runId })).rejects.toThrow();
  await expect(adapter.cancel!({ owner: input.owner, chatId: "other_chat", runId: input.runId })).rejects.toThrow();
  expect(broker.closeRun).not.toHaveBeenCalled();
  native.resolve({ runId: input.runId, status: "ok" });
  for (;;) { if ((await iterator.next()).done) break; }
  expect(broker.closeRun).toHaveBeenCalledOnce();
});
it("sends native abort and starts browser revocation before a slow drain finishes", async () => {
  const { broker, rpc, adapter } = setup();
  const drain = Promise.withResolvers<void>();
  const agent = Promise.withResolvers<unknown>();
  broker.closeRun.mockImplementationOnce(() => drain.promise);
  rpc.call.mockImplementation(async (method: string, _args, _signal, options) => {
    if (method === "matrix.browser.bind") return { bound: true };
    if (method === "agent") { options?.onDispatched?.(); return agent.promise; }
    if (method === "matrix.browser.revoke") return { revoked: true };
    if (method === "chat.abort") return { ok: true };
    throw new Error("Unexpected native method");
  });
  const iterator = adapter.start(input)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "state.updated" });
  const nativeSignal = rpc.call.mock.calls.find(call => call[0] === "agent")![2] as AbortSignal;
  const cancelling = adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId });
  try {
    await vi.waitFor(() => expect(rpc.call.mock.calls.map(call => call[0])).toContain("chat.abort"), { timeout: 250 });
    expect(broker.closeRun).toHaveBeenCalledWith(input.runId);
    // Keep the RPC correlation alive briefly for a late accepted run ID.
    expect(nativeSignal.aborted).toBe(false);
  } finally {
    drain.resolve(); agent.resolve({ runId: input.runId, status: "error" });
    await cancelling;
    for (;;) { if ((await iterator.next()).done) break; }
  }
});
it("keeps the real native plugin bypass guard while canonical cancellation waits for native abort", async () => {
  const { rpc, adapter } = setup();
  const methods = new Map<string, (input: { params: unknown; respond(ok: boolean, result?: unknown): void }) => Promise<void>>();
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
  const stopPlugin = registerOpenClawSharedBrowserPlugin({
    registerGatewayMethod: (name, handler) => { methods.set(name, handler); },
    registerTool: () => {},
    on: (name, handler) => { hooks.set(name, handler as never); },
  }, { gatewayPort: 4000, fetcher: vi.fn<typeof fetch>(async () => Response.json({ success: true })) });
  const native = Promise.withResolvers<unknown>();
  const abort = Promise.withResolvers<unknown>();
  let sessionKey!: string;
  rpc.call.mockImplementation(async (method, args, _signal, options) => {
    if (methods.has(method)) {
      if (method === "matrix.browser.bind") sessionKey = (args as { sessionKey: string }).sessionKey;
      let result: unknown;
      await methods.get(method)!({ params: args, respond: (ok, value) => {
        if (!ok) throw new Error("Binding refused"); result = value;
      } });
      return result;
    }
    if (method === "agent") {
      options?.onAccepted?.({ runId: input.runId, sessionKey, status: "accepted" });
      return native.promise;
    }
    if (method === "chat.abort") return abort.promise;
    throw new Error("Unexpected native method");
  });
  const iterator = adapter.start(input)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: "state.updated" });
  const context = { runId: input.runId, sessionKey, toolCallId: "claim_1" };
  hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "snapshot" } }, context);
  const cancelling = adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId });
  try {
    await vi.waitFor(() => expect(rpc.call.mock.calls.map(call => call[0])).toContain("matrix.browser.revoke"));
    expect(rpc.call.mock.calls.map(call => call[0])).toContain("chat.abort");
    for (const toolName of ["browser", "exec", "process"]) {
      expect(hooks.get("before_tool_call")!({ toolName }, context)).toMatchObject({ block: true });
    }
    hooks.get("agent_end")!({}, context);
    expect(hooks.get("before_tool_call")!({ toolName: "exec" }, context)).toBeUndefined();
  } finally {
    abort.resolve({ ok: true }); native.resolve({ runId: input.runId, status: "error" });
    await cancelling;
    for (;;) { if ((await iterator.next()).done) break; }
    stopPlugin();
  }
});
it("fails closed when native acceptance changes the browser-bound run or session", async () => {
  const { broker, rpc, adapter } = setup();
  rpc.call.mockImplementationOnce(async () => ({ bound: true })).mockImplementationOnce(async (_method, _args, _signal, options) => {
    options?.onAccepted?.({ runId: "native_other", sessionKey: "other_session", status: "accepted" });
    return { runId: "native_other", status: "ok" };
  });
  const rows = await collect(adapter.start(input));
  expect(rows.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
  expect(broker.closeRun).toHaveBeenCalledWith(input.runId);
});

it("keeps the browser lease bounded independently of ordinary busy turns and explicit overrides", async () => {
  const browser = setup(); await collect(browser.adapter.start(input));
  const native = browser.rpc.call.mock.calls.find(call => call[0] === "agent")!;
  expect(native[1]).toMatchObject({ timeout: 1800 }); expect(native[3]).toMatchObject({ timeoutMs: 1_800_000 });
  const supervised = setup(); await collect(supervised.adapter.start({ ...input, permissionMode: "supervised" }));
  expect(supervised.rpc.call.mock.calls.find(call => call[0] === "agent")![1]).toMatchObject({ timeout: 0 });
  const override = setup(false, 5000); await collect(override.adapter.start(input));
  expect(override.rpc.call.mock.calls.find(call => call[0] === "agent")![1]).toMatchObject({ timeout: 5 });
});

it.each(["signal", "canonical_cancel"])("reclaims an acknowledged browser bind cancelled before native dispatch via %s", async cancellation => {
  const { rpc, adapter } = setup();
  const controller = new AbortController();
  const methods = new Map<string, (input: { params: unknown; respond(ok: boolean, result?: unknown): void }) => Promise<void>>();
  const stopPlugin = registerOpenClawSharedBrowserPlugin({
    registerGatewayMethod: (name, handler) => { methods.set(name, handler); }, registerTool: () => {}, on: () => {},
  }, { gatewayPort: 4000, fetcher: vi.fn<typeof fetch>(async () => Response.json({ success: true })) });
  let firstBind = true;
  rpc.call.mockImplementation(async (method, args, _signal, options) => {
    if (methods.has(method)) {
      let result: unknown;
      await methods.get(method)!({ params: args, respond(ok, value) { if (!ok) throw new Error("Binding refused"); result = value; } });
      if (method === "matrix.browser.bind" && firstBind) {
        firstBind = false;
        if (cancellation === "signal") controller.abort();
        else await adapter.cancel!({ owner: input.owner, chatId: input.chatId, runId: input.runId });
      }
      return result;
    }
    if (method === "agent") {
      const request = args as { idempotencyKey: string; sessionKey: string };
      options?.onAccepted?.({ runId: request.idempotencyKey, sessionKey: request.sessionKey, status: "accepted" });
      return { runId: request.idempotencyKey, status: "ok" };
    }
    if (method === "chat.abort") return { ok: true };
    throw new Error("Unexpected native method");
  });
  try {
    const rows = await collect(adapter.start({ ...input, signal: controller.signal }));
    expect(rows.at(-1)).toMatchObject({ type: "run.completed", outcome: "aborted" });
    expect(rpc.call.mock.calls.map(call => call[0])).not.toContain("agent");
    const retry = await collect(adapter.start({ ...input, runId: "run_retry" }));
    expect(retry.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    expect(rpc.call.mock.calls.filter(call => call[0] === "agent")).toHaveLength(1);
  } finally { stopPlugin(); }
});
