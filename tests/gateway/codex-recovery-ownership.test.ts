import { expect, it, vi } from "vitest";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { createCodexBrowserRunScope } from "../../packages/gateway/src/chat/codex-browser-run-scope.js";

function fixture(startSession: () => Promise<unknown>, stopSession = vi.fn(async () => ({ ok: true }))) {
  let live = true;
  const onCleanupUnconfirmed = vi.fn();
  const broker = { openRun: (_binding, signal: AbortSignal) => {
    live = true; signal.addEventListener("abort", () => { live = false; });
    return { token: "a".repeat(43), expiresAt: 1, close: async () => { live = false; } };
  }, resolveCapability: () => live ? {} : null } as never;
  const scope = createCodexBrowserRunScope({ broker, gatewayPort: 4000 });
  const input = { owner: { type: "personal", ownerId: "owner_recovery" }, chatId: "chat_recovery", runId: "run_recovery",
    permissionMode: "full_access", interactionMode: "default", signal: new AbortController().signal, onCleanupUnconfirmed };
  const attempt = scope.open(input);
  const previous = { id: "sess_recovery", ownerId: input.owner.ownerId, kind: "agent", agent: "codex" };
  const getSession = vi.fn(async () => ({ ok: true, session: previous }));
  const prepareBrowser = vi.fn(async () => undefined), unwatch = vi.fn();
  const unavailable = Object.assign(new Error("Synthetic unavailable control"), { name: "CodexControlUnavailableError" });
  const provider = createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex",
    runtime: { startSession, stopSession, getSession } as never,
    codexEvents: { watch: async () => ({ offset: 0 }), unwatch, healthCheck: async () => ({ ok: true }), markStopped: vi.fn() },
    codexControl: { prepareBrowser, submitTurn: async () => { throw unavailable; } } as never, sharedBrowserEnabled: true });
  const context = { principal: { userId: input.owner.ownerId }, thread: { id: "thread_recovery" },
    turn: { message: "Synthetic recovery", turnId: "turn_recovery" }, resumeState: { conversationId: "sess_recovery", providerThreadId: "synthetic-native-thread" },
    signal: input.signal, now: () => new Date(0), nextEventId: () => "evt_recovery" } as never;
  return { scope, input, attempt, prepareBrowser, stopSession, unwatch, onCleanupUnconfirmed, getSession,
    resume: () => attempt.withContext(() => provider.resumeTurn!(context)), isLive: () => live };
}
const failed = (code: string) => ({ ok: false, status: 503, error: { code, message: "Runtime unavailable" } });
const started = () => ({ ok: true, status: 200, session: { runtime: { type: "background", status: "running", createdAt: "2026-10-15T00:00:00.000Z" } } });
it("retains recovery startup ownership before preparation can report a generic failure", async () => {
  const f = fixture(async () => failed("runtime_ownership_retained"));
  await expect(f.resume()).rejects.toThrow("Workspace provider turn recovery failed");
  await expect(f.attempt.close()).rejects.toThrow("Browser cleanup unconfirmed");
  expect(f.onCleanupUnconfirmed).toHaveBeenCalledOnce();
  expect(f.stopSession).not.toHaveBeenCalled();
  expect(f.prepareBrowser).not.toHaveBeenCalled();
  expect(() => f.scope.open(f.input)).toThrow("Browser run unavailable");
});
it("retains admission for an unexpected recovery-start exception without masking it", async () => {
  const failure = new Error("Synthetic uncertain recovery");
  const f = fixture(async () => { throw failure; });
  await expect(f.resume()).rejects.toBe(failure);
  await expect(f.attempt.close()).rejects.toThrow("Browser cleanup unconfirmed");
  expect(f.onCleanupUnconfirmed).toHaveBeenCalledOnce();
});
it("releases a recovery failure with confirmed cleanup", async () => {
  const f = fixture(async () => failed("runtime_unavailable"));
  await expect(f.resume()).rejects.toThrow("Workspace provider turn recovery failed");
  await f.attempt.close(); expect(f.onCleanupUnconfirmed).not.toHaveBeenCalled();
  await f.scope.open(f.input).close();
});
it.each([true, false])("cancellation waits for pending recovery and physical stop without late binding (confirmed=%s)", async confirmed => {
  let resolveStart!: (result: unknown) => void, resolveStop!: (result: { ok: boolean }) => void;
  const entered = vi.fn();
  const stop = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { resolveStop = resolve; }));
  const f = fixture(() => { entered(); return new Promise(resolve => { resolveStart = resolve; }); }, stop as never);
  const resume = f.resume().then(() => ({ error: undefined }), error => ({ error }));
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  let settled = false;
  const cancelled = f.scope.cancel({ ownerId: f.input.owner.ownerId, chatId: f.input.chatId, runId: f.input.runId })
    .then(() => { settled = true; return { error: undefined }; }, error => { settled = true; return { error }; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeChild = settled;
  resolveStart(started());
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  const settledBeforeStop = settled;
  resolveStop({ ok: confirmed });
  expect((await resume).error).toBeInstanceOf(Error);
  const result = await cancelled;
  expect(settledBeforeChild).toBe(false);expect(settledBeforeStop).toBe(false);
  expect(f.prepareBrowser).not.toHaveBeenCalled();
  if (confirmed) { expect(result.error).toBeUndefined(); await f.attempt.close(); expect(f.onCleanupUnconfirmed).not.toHaveBeenCalled(); }
  else { expect(result.error).toEqual(expect.objectContaining({ message: "Browser cleanup unconfirmed" })); await expect(f.attempt.close()).rejects.toThrow("Browser cleanup unconfirmed"); expect(f.onCleanupUnconfirmed).toHaveBeenCalledOnce(); }
});
it("does not launch recovery after cancellation while reading durable identity", async () => {
  let finishRead!: (value: unknown) => void;
  const start = vi.fn(async () => started());
  const f = fixture(start);
  f.getSession.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }) as never);
  const resume = f.resume().then(() => ({ error: undefined }), error => ({ error }));
  await vi.waitFor(() => expect(f.getSession).toHaveBeenCalledOnce());
  const cancel = f.scope.cancel({ ownerId: f.input.owner.ownerId, chatId: f.input.chatId, runId: f.input.runId });
  finishRead({ ok: true, session: { id: "sess_recovery", ownerId: f.input.owner.ownerId, kind: "agent", agent: "codex" } });
  expect((await resume).error).toBeInstanceOf(Error);await cancel;await f.attempt.close();
  expect(start).not.toHaveBeenCalled();expect(f.prepareBrowser).not.toHaveBeenCalled();expect(f.onCleanupUnconfirmed).not.toHaveBeenCalled();
});

it("keeps ordinary confirmed recovery binding available", async () => {
  const f = fixture(async () => started());
  expect(await f.resume()).toMatchObject({ outcome: "delivered" });
  expect(f.prepareBrowser).toHaveBeenCalledOnce();expect(f.onCleanupUnconfirmed).not.toHaveBeenCalled();await f.attempt.close();
});
it("drains a late recovery bind acknowledgement after cancellation before releasing admission", async () => {
  let finishPrepare!: () => void;
  const f = fixture(async () => started());
  f.prepareBrowser.mockImplementationOnce(() => new Promise<void>(resolve => { finishPrepare = resolve; }));
  const resume = f.resume().then(() => ({ error: undefined }), error => ({ error }));
  await vi.waitFor(() => expect(f.prepareBrowser).toHaveBeenCalledOnce());
  const cancel = f.scope.cancel({ ownerId: f.input.owner.ownerId, chatId: f.input.chatId, runId: f.input.runId });
  finishPrepare();
  expect((await resume).error).toBeInstanceOf(Error);
  await cancel;await f.attempt.close();expect(f.stopSession).toHaveBeenCalledOnce();expect(f.onCleanupUnconfirmed).not.toHaveBeenCalled();
});
