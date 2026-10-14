import { expect, it, vi } from "vitest";
import { createOpenClawChatProviderAdapter } from "../../packages/gateway/src/chat/openclaw-provider-adapter.js";
const input = { owner: { type: "personal" as const, ownerId: "owner_qa" }, chatId: "chat_qa", runId: "run_qa", turnId: "turn_qa", prompt: "Collect fixture invoices", parts: [{ type: "text" as const, text: "Collect fixture invoices" }],
  selection: { instanceId: "openclaw_default", model: "openai:gpt-5.4" }, interactionMode: "default", permissionMode: "full_access", signal: new AbortController().signal };
const collect = async (source: AsyncIterable<unknown>) => { const rows = []; for await (const row of source) rows.push(row); return rows; };
function setup(failBind = false, timeoutMs?: number) {
  const broker = { openRun: vi.fn(() => ({ token: "a".repeat(43), expiresAt: Date.now()+60000 })), closeRun: vi.fn(async () => undefined) };
  const rpc = { call: vi.fn(async (method: string, _args: unknown, _signal: unknown, options?: { onAccepted?: (value: unknown) => void }) => {
    if (method === "matrix.browser.bind") { if (failBind) throw new Error("plugin unavailable"); return { bound: true }; }
    if (method === "matrix.browser.revoke") return { revoked: true };
    if (method === "agent") { options?.onAccepted?.({ runId: input.runId, sessionKey: (_args as { sessionKey: string }).sessionKey, status: "accepted" }); return { runId: input.runId, status: "ok" }; }
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

it("allows bounded human pauses within browser native runs without widening ordinary runs or explicit overrides", async () => {
  const browser = setup(); await collect(browser.adapter.start(input));
  const native = browser.rpc.call.mock.calls.find(call => call[0] === "agent")!;
  expect(native[1]).toMatchObject({ timeout: 1800 }); expect(native[3]).toMatchObject({ timeoutMs: 1_800_000 });
  const supervised = setup(); await collect(supervised.adapter.start({ ...input, permissionMode: "supervised" }));
  expect(supervised.rpc.call.mock.calls.find(call => call[0] === "agent")![1]).toMatchObject({ timeout: 120 });
  const override = setup(false, 5000); await collect(override.adapter.start(input));
  expect(override.rpc.call.mock.calls.find(call => call[0] === "agent")![1]).toMatchObject({ timeout: 5 });
});
