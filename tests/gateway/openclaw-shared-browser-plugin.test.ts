import { expect, it, vi } from "vitest";
import { registerOpenClawSharedBrowserPlugin } from "../../packages/gateway/src/chat/openclaw-shared-browser-plugin.js";

function setup(now?: () => number) {
  const methods = new Map<string, (input: { params: unknown; respond: (...args: unknown[]) => void }) => Promise<void>>();
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
  let factory: (context: { sessionKey: string }) => { execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<unknown> };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
  const api = { registerGatewayMethod: (name: string, handler: (input: never) => Promise<void>) => methods.set(name, handler as never),
    registerTool: (value: typeof factory) => { factory = value; },
    on: (name: string, handler: (event: unknown, context: unknown) => unknown) => hooks.set(name, handler),
    lifecycle: { registerRuntimeLifecycle: vi.fn() } };
  const close = registerOpenClawSharedBrowserPlugin(api as never, { gatewayPort: 4000, fetcher, now });
  const bind = async () => { const respond = vi.fn(); await methods.get("matrix.browser.bind")!({ params: { runId: "run_qa", sessionKey: "agent:main:qa", token: "a".repeat(43), expiresAt: (now?.() ?? Date.now()) + 60000 }, respond }); return respond; };
  return { methods, hooks, fetcher, close, bind, tool: () => factory!({ sessionKey: "agent:main:qa" }) };
}
it.each(["revoke", "expire"])("keeps native bypasses blocked after %s until the native run ends", async reason => {
  let now = Date.now();
  const s = setup(() => now); await s.bind();
  const context = { runId: "run_qa", sessionKey: "agent:main:qa", toolCallId: "claim_1" };
  const stamped = s.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "snapshot" } }, context) as { params: unknown };
  if (reason === "revoke") {
    await s.methods.get("matrix.browser.revoke")!({ params: { runId: context.runId }, respond: vi.fn() });
  } else now += 60_001;
  for (const name of ["browser", "exec", "execute", "bash", "process"]) {
    expect(s.hooks.get("before_tool_call")!({ toolName: name }, context)).toMatchObject({ block: true });
  }
  const before = s.fetcher.mock.calls.length;
  await expect(s.tool().execute("claim_1", stamped.params)).rejects.toThrow();
  expect(s.fetcher).toHaveBeenCalledTimes(before);
  expect(s.hooks.get("before_tool_call")!({ toolName: "exec" }, { ...context, runId: "normal_other", sessionKey: "other" })).toBeUndefined();
  // Absence of a native terminal event must not release the bypass guard.
  now += 31 * 60_000;
  expect(s.hooks.get("before_tool_call")!({ toolName: "exec" }, context)).toMatchObject({ block: true });
  s.hooks.get("agent_end")!({}, context);
  expect(s.hooks.get("before_tool_call")!({ toolName: "exec" }, context)).toBeUndefined();
  s.close();
});
it("revokes bearer tickets and in-flight calls immediately while keeping native shell fallbacks blocked", async () => {
  const s = setup(); await s.bind();
  const context = { runId: "run_qa", sessionKey: "agent:main:qa", toolCallId: "call_1" };
  const stamped = s.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "snapshot" } }, context) as { params: unknown };
  let signal!: AbortSignal;
  s.fetcher.mockImplementationOnce(async (_url, init) => {
    signal = init!.signal!;
    return await new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  });
  const pending = s.tool().execute("call_1", stamped.params);
  const rejected = expect(pending).rejects.toThrow();
  await s.methods.get("matrix.browser.revoke")!({ params: { runId: context.runId }, respond: vi.fn() });
  expect(signal.aborted).toBe(true);
  await rejected;
  expect(s.hooks.get("before_tool_call")!({ toolName: "process" }, context)).toMatchObject({ block: true });
  s.close();
});
it("caps active and revoked run guards together and frees capacity only on native completion", async () => {
  const s = setup();
  const binding = (index: number, sessionKey = `session_${index}`) => ({ runId: `run_${index}`, sessionKey, token: "a".repeat(43), expiresAt: Date.now() + 60_000 });
  for (let index = 0; index < 64; index++) {
    await s.methods.get("matrix.browser.bind")!({ params: binding(index), respond: vi.fn() });
    await s.methods.get("matrix.browser.revoke")!({ params: { runId: `run_${index}` }, respond: vi.fn() });
  }
  const full = vi.fn();
  await s.methods.get("matrix.browser.bind")!({ params: binding(64), respond: full });
  expect(full).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  expect(s.fetcher).toHaveBeenCalledTimes(64);
  s.hooks.get("agent_end")!({}, { runId: "run_0" });
  const retry = vi.fn();
  await s.methods.get("matrix.browser.bind")!({ params: binding(64, "session_0"), respond: retry });
  expect(retry).toHaveBeenCalledWith(true, { bound: true });
  s.close();
});
it("binds native OpenClaw run context and calls only the fixed broker with an opaque one-use ticket", async () => {
  const s = setup();
  expect(await s.bind()).toHaveBeenCalledWith(true, { bound: true });
  const stamped = await s.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "status" } },
    { toolName: "shared_browser", runId: "run_qa", sessionKey: "agent:main:qa", toolCallId: "call_1" }) as { params: Record<string, unknown> };
  expect(stamped.params).not.toHaveProperty("token");
  await s.tool().execute("call_1", stamped.params, new AbortController().signal);
  expect(s.fetcher).toHaveBeenLastCalledWith("http://127.0.0.1:4000/apps/browser-lab/api/agent-action", expect.objectContaining({ redirect: "error", body: '{"action":"status"}', signal: expect.any(AbortSignal) }));
  await expect(s.tool().execute("call_1", stamped.params)).rejects.toThrow();
  s.close();
});
it("blocks bypasses and stale/foreign native contexts but does not intercept other owner's normal runs", async () => {
  const s = setup(); await s.bind();
  expect(await s.hooks.get("before_tool_call")!({ toolName: "exec", params: {} }, { runId: "run_qa", sessionKey: "agent:main:qa", toolName: "exec" })).toBeUndefined();
  await s.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "snapshot" } }, { runId: "run_qa", sessionKey: "agent:main:qa", toolName: "shared_browser", toolCallId: "claim_1" });
  for (const name of ["browser", "exec", "process"]) {
    expect(await s.hooks.get("before_tool_call")!({ toolName: name, params: {} }, { runId: "run_qa", sessionKey: "agent:main:qa", toolCallId: "call_1", toolName: name })).toMatchObject({ block: true });
  }
  expect(await s.hooks.get("before_tool_call")!({ toolName: "exec", params: {} }, { runId: "normal_other", sessionKey: "other", toolName: "exec" })).toBeUndefined();
  expect(await s.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "status" } }, { runId: "run_other", sessionKey: "agent:main:qa", toolCallId: "call_1", toolName: "shared_browser" })).toMatchObject({ block: true });
  await expect(s.tool().execute("call_1", { action: "status", token: "a".repeat(43) })).rejects.toThrow();
  const respond = vi.fn(); await s.methods.get("matrix.browser.revoke")!({ params: { runId: "run_qa" }, respond });
  expect(respond).toHaveBeenCalledWith(true, { revoked: true });
  expect(await s.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "status" } }, { runId: "run_qa", sessionKey: "agent:main:qa", toolCallId: "call_1", toolName: "shared_browser" })).toMatchObject({ block: true });
  s.close();
});
it("refuses expired leases and invalid remote endpoints before native dispatch", async () => {
  const s = setup(); const respond = vi.fn();
  await s.methods.get("matrix.browser.bind")!({ params: { runId: "run_qa", sessionKey: "agent:main:qa", token: "a".repeat(43), expiresAt: Date.now() - 1 }, respond });
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  expect(s.fetcher).not.toHaveBeenCalled();
  s.close();
});
it("caps concurrent native lease authentication before any network await", async () => {
  const s = setup(); const pending = Promise.withResolvers<Response>(); s.fetcher.mockImplementation(async () => (await pending.promise).clone());
  const responses = Array.from({ length: 65 }, () => vi.fn());
  const jobs = responses.map((respond, index) => s.methods.get("matrix.browser.bind")!({ params: { runId: `run_${index}`, sessionKey: `session_${index}`, token: "a".repeat(43), expiresAt: Date.now()+60000 }, respond }));
  expect(s.fetcher).toHaveBeenCalledTimes(64);
  pending.resolve(Response.json({ success: true }));
  await Promise.all(jobs); s.close();
});
it("cannot resurrect a revoked lease after delayed native authentication completes", async () => {
  const s = setup(); const pending = Promise.withResolvers<Response>(); s.fetcher.mockImplementation(async () => pending.promise);
  const binding = s.bind(); await vi.waitFor(() => expect(s.fetcher).toHaveBeenCalledOnce());
  const respond = vi.fn(); await s.methods.get("matrix.browser.revoke")!({ params: { runId: "run_qa" }, respond });
  pending.resolve(Response.json({ success: true }));
  expect(await binding).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
  expect(await s.hooks.get("before_tool_call")!({ toolName: "shared_browser", params: { action: "status" } }, { runId: "run_qa", sessionKey: "agent:main:qa", toolCallId: "late_1", toolName: "shared_browser" })).toMatchObject({ block: true });
  s.close();
});
