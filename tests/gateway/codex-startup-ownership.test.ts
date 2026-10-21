import { mkdtemp, rm } from "node:fs/promises";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCanonicalCodingChatProviderAdapter } from "../../packages/gateway/src/chat/coding-provider-adapter.js";
import { expect, it, vi } from "vitest";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { createCodexBrowserRunScope } from "../../packages/gateway/src/chat/codex-browser-run-scope.js";

function fixture(startSession: (...args: unknown[]) => Promise<unknown>) {
  let live = true;
  const onCleanupUnconfirmed = vi.fn();
  const broker = { openRun: (_binding, signal: AbortSignal) => {
    live = true;
    signal.addEventListener("abort", () => { live = false; });
    return { token: "a".repeat(43), expiresAt: 1, close: async () => { live = false; } };
  }, resolveCapability: () => live ? {} : null } as never;
  const scope = createCodexBrowserRunScope({ broker, gatewayPort: 4000 });
  const input = { owner: { type: "personal", ownerId: "owner_startup" }, chatId: "chat_startup", runId: "run_startup",
    permissionMode: "full_access", interactionMode: "default", signal: new AbortController().signal, onCleanupUnconfirmed };
  const attempt = scope.open(input);
  const prepareBrowser = vi.fn(async () => undefined);
  const stopSession = vi.fn(async () => ({ ok: false }));
  const unwatch = vi.fn();
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex",
    runtime: { startSession, stopSession } as never,
    codexEvents: { watch: async () => ({}), unwatch, healthCheck: async () => ({ ok: true }), markStopped: vi.fn() },
    codexControl: { prepareBrowser } as never, sharedBrowserEnabled: true });
  const context = { principal: { userId: input.owner.ownerId }, thread: { id: "thread_startup" },
    request: { prompt: "Synthetic startup" }, signal: input.signal, now: () => new Date(0), nextEventId: () => "evt_startup" } as never;
  return { scope, input, attempt, provider, broker, prepareBrowser, stopSession, unwatch, onCleanupUnconfirmed,
    start: () => attempt.withContext(() => provider.startThread!(context)), isLive: () => live };
}
const failed = (code: string) => ({ ok: false, status: 503, error: { code, message: "Runtime unavailable" } });

it("retains admission when native startup reports unconfirmed ownership before browser preparation", async () => {
  const f = fixture(async () => failed("runtime_ownership_retained"));
  await expect(f.start()).rejects.toThrow("Workspace provider start failed");
  await expect(f.attempt.close()).rejects.toThrow("Browser cleanup unconfirmed");
  expect(f.onCleanupUnconfirmed).toHaveBeenCalledOnce();
  expect(f.isLive()).toBe(false);
  expect(f.prepareBrowser).not.toHaveBeenCalled();
  expect(f.stopSession).not.toHaveBeenCalled();
  expect(() => f.scope.open(f.input)).toThrow("Browser run unavailable");
  expect(f.unwatch).toHaveBeenCalledOnce();
});
it("releases admission for a native startup failure whose cleanup was confirmed", async () => {
  const f = fixture(async () => failed("runtime_unavailable"));
  await expect(f.start()).rejects.toThrow("Workspace provider start failed");
  await f.attempt.close();
  expect(f.onCleanupUnconfirmed).not.toHaveBeenCalled();
  await f.scope.open(f.input).close();
});
it("retains admission when startup throws without evidence of physical cleanup", async () => {
  const failure = new Error("Synthetic uncertain startup");
  const f = fixture(async () => { throw failure; });
  await expect(f.start()).rejects.toBe(failure);
  await expect(f.attempt.close()).rejects.toThrow("Browser cleanup unconfirmed");
  expect(f.onCleanupUnconfirmed).toHaveBeenCalledOnce();
  expect(f.stopSession).not.toHaveBeenCalled();
});
it("registers pending cleanup before startup so cancellation cannot release a delayed native child", async () => {
  let resolve!: (result: unknown) => void;
  const entered = vi.fn();
  const f = fixture(() => { entered(); return new Promise(done => { resolve = done; }); });
  const startup = f.start();
  const startupResult = expect(startup).rejects.toThrow("Workspace provider start failed");
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  let settled = false;
  const cancelled = f.scope.cancel({ ownerId: f.input.owner.ownerId, chatId: f.input.chatId, runId: f.input.runId });
  const cancelResult = cancelled.then(() => { settled = true; return { error: undefined }; }, error => { settled = true; return { error }; });
  await new Promise(done => setImmediate(done));
  const releasedBeforeStartupSettled = settled;
  expect(f.isLive()).toBe(false);
  resolve(failed("runtime_ownership_retained"));
  await startupResult;
  expect((await cancelResult).error).toEqual(expect.objectContaining({ message: "Browser cleanup unconfirmed" }));
  expect(releasedBeforeStartupSettled).toBe(false);
  await expect(f.attempt.close()).rejects.toThrow("Browser cleanup unconfirmed");
  expect(() => f.scope.open(f.input)).toThrow("Browser run unavailable");
});

it("preserves startup ownership retention through durable failed Chat projection", async () => {
  const f = fixture(async () => failed("runtime_ownership_retained"));
  await f.attempt.close();
  const home = await mkdtemp("/tmp/mx-startup-retention-");
  const threads = createCodingAgentThreadStore({ homePath: home, providers: [f.provider],
    relationValidator: { validateCreate: async () => {}, validateThread: async () => {} } });
  const adapter = createCanonicalCodingChatProviderAdapter({ providerId: "codex", threads, sharedBrowser: f.broker, gatewayPort: 4000 });
  const input = { ...f.input, owner: { type: "personal" as const, ownerId: f.input.owner.ownerId },
    prompt: "Synthetic startup", turnId: "cturn_startup", parts: [{ type: "text" as const, text: "Synthetic startup" }],
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" } };
  const projected: Array<{ type: string; outcome?: string }> = [];
  try {
    await expect((async () => { for await (const event of adapter.start!(input)) projected.push(event); })())
      .rejects.toThrow("Browser cleanup unconfirmed");
    expect(projected).toContainEqual(expect.objectContaining({ type: "run.completed", outcome: "failed" }));
    expect(f.onCleanupUnconfirmed).toHaveBeenCalledOnce();
    expect(f.isLive()).toBe(false);
    expect(f.stopSession).not.toHaveBeenCalled();
    await expect(adapter.start!(input).next()).rejects.toThrow("Browser run unavailable");
  } finally { await threads.shutdownTurns(); await rm(home, { recursive: true, force: true }); }
});
