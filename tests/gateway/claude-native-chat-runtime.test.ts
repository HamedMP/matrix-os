import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  pool: { runTurn: vi.fn(), setScheduledHandler: vi.fn(), cancel: vi.fn(), restoreIdle: vi.fn(), close: vi.fn(async () => {}) },
  createPool: vi.fn(),
  createInitial: vi.fn(),
  createCoding: vi.fn(),
}));
vi.mock("../../packages/gateway/src/chat/claude-native-session.js", () => ({ createClaudeNativeSessionPool: mocks.createPool }));
vi.mock("../../packages/gateway/src/server/initial-chat-adapters.js", () => ({ createInitialChatAdapters: mocks.createInitial }));
vi.mock("../../packages/gateway/src/chat/coding-provider-adapter.js", () => ({ createCanonicalCodingChatProviderAdapter: mocks.createCoding }));
import { createGatewayClaudeChatRuntime, type ClaudeNativeRecoveryHost } from "../../packages/gateway/src/chat/claude-native-chat-runtime.js";
import { buildClaudeNativeReplayJsonl } from "../../packages/gateway/src/chat/claude-native-recovery-replay.js";
import type { ClaudeNativeIdleRestoreOptions } from "../../packages/gateway/src/chat/claude-native-session.js";
import type { ClaudeNativeRecoveryInput, ClaudeNativeRecoveryReceipt } from "../../packages/gateway/src/chat/claude-native-recovery-store.js";
import { createGatewayChatAdapters } from "../../packages/gateway/src/server/canonical-chat-adapters.js";

beforeEach(() => vi.clearAllMocks());

describe("gateway Claude native session composition", () => {
  it("runs optional recovery after run reconciliation without blocking Gateway readiness", async () => {
    const source = ts.createSourceFile("server.ts", await readFile("packages/gateway/src/server.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const calls = new Map<string, ts.CallExpression>();
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        if (ts.isIdentifier(callee)) calls.set(callee.text, node);
      }
      node.forEachChild(visit);
    }
    visit(source);
    const recovery = calls.get("startGatewayClaudeNativeRecovery")!;
    expect(recovery.getStart(source)).toBeGreaterThan(calls.get("reconcileActiveRuns")!.getStart(source));
    expect(recovery.getStart(source)).toBeGreaterThan(calls.get("serve")!.getStart(source));
    let ancestor: ts.Node = recovery;
    while (!ts.isExpressionStatement(ancestor.parent)) ancestor = ancestor.parent;
    expect(ts.isVoidExpression(ancestor)).toBe(true);
    const callback = ancestor.parent.parent.parent;
    expect(ts.isArrowFunction(callback)).toBe(true);
    const listener = callback.parent;
    expect(ts.isCallExpression(listener) && ts.isPropertyAccessExpression(listener.expression)
      && listener.expression.name.text === "once" && listener.arguments[0]?.getText(source) === '"listening"').toBe(true);
  });

  it("creates the explicitly qualified transport and binds only the private current orchestrator", async () => {
    mocks.createPool.mockReturnValue(mocks.pool);
    const runtime = createGatewayClaudeChatRuntime({ homePath: "/owner" });
    expect(mocks.createPool).toHaveBeenCalledWith({ protocolQualified: true });
    const admitNativeScheduledPhase = vi.fn(async () => {});
    let current: { admitNativeScheduledPhase: typeof admitNativeScheduledPhase } | null = { admitNativeScheduledPhase };
    runtime.bind(() => current);
    const handler = mocks.pool.setScheduledHandler.mock.calls.at(-1)![0];
    const request = { owner: { type: "personal", ownerId: "owner_a" }, chatId: "chat_a", sourceRunId: "run_a", sessionId: "native_a", promptId: "prompt_a", prompt: "due" };
    await handler(request);
    expect(admitNativeScheduledPhase).toHaveBeenCalledExactlyOnceWith(request);
    current = null;
    await expect(handler(request)).rejects.toThrow("Native scheduled Chat unavailable");
    expect(admitNativeScheduledPhase).toHaveBeenCalledOnce();
    await runtime.close(); expect(mocks.pool.close).toHaveBeenCalledOnce();
  });

  it("keeps provider registration order and existing routine/browser dependencies", () => {
    mocks.createPool.mockReturnValue(mocks.pool);
    const initialAdapter = { driverKind: "kernel" };
    const botAdapter = { driverKind: "bot" };
    const managedBotAdapter = { driverKind: "matrix_pi" };
    mocks.createInitial.mockReturnValue([initialAdapter]);
    mocks.createCoding.mockImplementation(options => ({ driverKind: options.providerId }));
    const routineCli = { runtime: {}, binPath: "/matrix", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute" };
    const sharedBrowser = {};
    const providers = ["opencode", "claude", "pi", "codex"].map(providerId => ({ providerId }));
    const initial = { homePath: "/owner", dispatcher: {}, rpc: {}, gatewayPort: 4000, routineCli, sharedBrowser };
    const result = createGatewayChatAdapters({ initial, providers, threads: {}, claude: {}, botAdapter, managedBotAdapter } as unknown as Parameters<typeof createGatewayChatAdapters>[0]);
    expect(mocks.createInitial).toHaveBeenCalledWith(initial);
    expect(result.adapters.map(adapter => adapter.driverKind)).toEqual(["kernel", "claude_code", "codex", "pi", "opencode", "bot", "matrix_pi"]);
    expect(result.nativeClaude?.adapter).toBe(result.adapters[1]);
    const codingCalls = mocks.createCoding.mock.calls.slice(-3).map(([options]) => options);
    expect(codingCalls[0]).toMatchObject({ providerId: "codex", routineCli, sharedBrowser, gatewayPort: 4000 });
    for (const options of codingCalls.slice(1)) {
      expect(options.routineCli).toBe(routineCli);
      expect(options).not.toHaveProperty("sharedBrowser");
      expect(options).not.toHaveProperty("gatewayPort");
    }
  });
});

const prompt = "native scheduled prompt";
const job = {
  id: "abcdef01", cron: "* * * * *", recurring: true,
  promptSha256: createHash("sha256").update(prompt).digest("hex"),
  assistantUuid: "09f23651-fd98-4642-8b79-6dc2e5688c8e",
  receiptUuid: "40c465b2-37e0-4eb4-b51d-d8bef1c69a1b",
};
function recoveryFixture() {
  const checkpoint: ClaudeNativeRecoveryInput = {
    ownerId: "owner_a", chatId: "chat_a", sourceRunId: "run_a",
    sessionId: "521f8f55-00ea-4dc1-a021-2b5155eb81ed", sourceFingerprint: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(), jobs: [job],
  };
  const released: ClaudeNativeRecoveryReceipt = { ...checkpoint, status: "released", generation: 2 };
  const active: ClaudeNativeRecoveryReceipt = { ...checkpoint, status: "active", generation: 3 };
  const store = {
    listRecoverable: vi.fn(async (_ownerId: string) => [released]),
    claim: vi.fn(async (_receipt: ClaudeNativeRecoveryReceipt) => active as ClaudeNativeRecoveryReceipt | null),
    saveActive: vi.fn(async (value: ClaudeNativeRecoveryInput, generation?: number) =>
      ({ ...value, status: "active", generation: (generation ?? 0) + 1 }) as ClaudeNativeRecoveryReceipt),
    release: vi.fn(async (receipt: ClaudeNativeRecoveryReceipt) => ({ ...receipt, status: "released" as const, generation: receipt.generation + 1 })),
  };
  const launchProtected = vi.fn<NonNullable<Awaited<ReturnType<ClaudeNativeRecoveryHost["prepare"]>>>["launchProtected"]>();
  const host = {
    prepare: vi.fn<ClaudeNativeRecoveryHost["prepare"]>(async () => ({ sourceFingerprint: checkpoint.sourceFingerprint, launchProtected })),
    revalidate: vi.fn<ClaudeNativeRecoveryHost["revalidate"]>(async () => true),
    checkpointAfterClose: vi.fn<ClaudeNativeRecoveryHost["checkpointAfterClose"]>(async () => true),
  };
  const request = {
    owner: { type: "personal" as const, ownerId: checkpoint.ownerId },
    chatId: checkpoint.chatId, sourceRunId: checkpoint.sourceRunId, sessionId: checkpoint.sessionId,
    promptId: "d4b19811-ce5d-478a-ae95-dde3b282a83d", prompt,
  };
  mocks.pool.close.mockReset().mockResolvedValue(undefined);
  mocks.pool.restoreIdle.mockReset().mockResolvedValue(undefined);
  mocks.createPool.mockReturnValue(mocks.pool);
  const runtime = createGatewayClaudeChatRuntime({ homePath: "/owner" });
  const admitNativeScheduledPhase = vi.fn(async () => {});
  runtime.bind(() => ({ admitNativeScheduledPhase }));
  return { runtime, host, launchProtected, store, checkpoint, released, active, request, admitNativeScheduledPhase,
    start: () => runtime.startRecovery({ ownerId: checkpoint.ownerId, host, store }),
    restored: () => mocks.pool.restoreIdle.mock.calls[0]?.[0] as ClaudeNativeIdleRestoreOptions };
}

describe("gateway protected Claude native recovery", () => {
  it("claims the scoped startup receipt, verifies the protected source, and fences every admitted callback", async () => {
    const f = recoveryFixture();
    await Promise.all([f.start(), f.start()]);
    expect(f.store.listRecoverable).toHaveBeenCalledExactlyOnceWith(f.checkpoint.ownerId);
    expect(f.store.claim).toHaveBeenCalledExactlyOnceWith(f.released);
    expect(f.host.prepare).toHaveBeenCalledExactlyOnceWith(f.active, expect.any(AbortSignal));
    expect(mocks.pool.restoreIdle).toHaveBeenCalledOnce();
    const restore = f.restored();
    expect(restore).toMatchObject({ sessionId: f.checkpoint.sessionId, input: { owner: f.request.owner,
      chatId: f.checkpoint.chatId, runId: f.checkpoint.sourceRunId, interactionMode: "default" }, jobs: [
      { id: job.id, cron: job.cron, recurring: true, promptSha256: job.promptSha256 },
    ] });
    await restore.admitRecoveredPhase(f.request, job, f.checkpoint);
    expect(f.admitNativeScheduledPhase).toHaveBeenCalledExactlyOnceWith({ ...f.request, recovery: {
      ownerId: f.checkpoint.ownerId, chatId: f.checkpoint.chatId, sourceRunId: f.checkpoint.sourceRunId,
      sourceFingerprint: f.checkpoint.sourceFingerprint, sessionId: f.checkpoint.sessionId, generation: 3,
      jobId: job.id, promptSha256: job.promptSha256,
    } });
    const checkpoint = { ...f.checkpoint, sourceRunId: "run_b" };
    await restore.admitRecoveredPhase({ ...f.request, sourceRunId: "run_b" }, job, checkpoint);
    expect(f.store.saveActive).toHaveBeenCalledExactlyOnceWith(checkpoint, 3);
    expect(f.admitNativeScheduledPhase).toHaveBeenLastCalledWith(expect.objectContaining({
      recovery: expect.objectContaining({ sourceRunId: "run_b", generation: 4 }),
    }));
  });

  it("rejects foreign, changed, and unchecked callbacks", async () => {
    const f = recoveryFixture();
    await f.start();
    const { admitRecoveredPhase } = f.restored();
    await expect(admitRecoveredPhase({ ...f.request, owner: { type: "personal", ownerId: "owner_b" } }, job, f.checkpoint)).rejects.toThrow();
    await expect(admitRecoveredPhase({ ...f.request, chatId: "chat_b" }, job, f.checkpoint)).rejects.toThrow();
    await expect(admitRecoveredPhase({ ...f.request, prompt: "wrong" }, job, f.checkpoint)).rejects.toThrow();
    await expect(admitRecoveredPhase(f.request, job)).rejects.toThrow();
    f.host.revalidate.mockResolvedValueOnce(false);
    await expect(admitRecoveredPhase(f.request, job, f.checkpoint)).rejects.toThrow();
    expect(f.admitNativeScheduledPhase).not.toHaveBeenCalled();
  });

  it("does not launch an unclaimed receipt or a mismatched protected source", async () => {
    const lostClaim = recoveryFixture();
    lostClaim.store.claim.mockResolvedValueOnce(null);
    await lostClaim.start();
    expect(lostClaim.host.prepare).not.toHaveBeenCalled();
    expect(mocks.pool.restoreIdle).not.toHaveBeenCalled();

    const mismatch = recoveryFixture();
    mismatch.host.prepare.mockResolvedValueOnce({ sourceFingerprint: "b".repeat(64), launchProtected: mismatch.launchProtected });
    await mismatch.start();
    expect(mocks.pool.restoreIdle).not.toHaveBeenCalled();

  });

  it("aborts startup and joins the release of a never-launched claim before close returns", async () => {
    const stopping = recoveryFixture();
    const preparing = Promise.withResolvers<AbortSignal>();
    const allowPrepare = Promise.withResolvers<void>();
    const releasing = Promise.withResolvers<void>();
    const allowRelease = Promise.withResolvers<void>();
    stopping.host.prepare.mockImplementation(async (_receipt, signal) => {
      preparing.resolve(signal);
      await allowPrepare.promise;
      return { sourceFingerprint: stopping.checkpoint.sourceFingerprint, launchProtected: stopping.launchProtected };
    });
    stopping.store.release.mockImplementation(async receipt => {
      releasing.resolve();
      await allowRelease.promise;
      return { ...receipt, status: "released", generation: receipt.generation + 1 };
    });
    const startup = stopping.start();
    const signal = await preparing.promise;
    let closed = false;
    const shutdown = stopping.runtime.close().then(() => { closed = true; });
    try {
      expect(signal.aborted).toBe(true);
      allowPrepare.resolve();
      await releasing.promise;
      expect(closed).toBe(false);
      expect(stopping.store.release).toHaveBeenCalledExactlyOnceWith(stopping.active);
    } finally {
      allowRelease.resolve();
      await Promise.all([startup, shutdown]);
    }
    expect(mocks.pool.restoreIdle).not.toHaveBeenCalled();
  });

  it("bounds shutdown even when the startup store read ignores cancellation", async () => {
    vi.useFakeTimers();
    const f = recoveryFixture();
    const read = Promise.withResolvers<ClaudeNativeRecoveryReceipt[]>();
    f.store.listRecoverable.mockReturnValueOnce(read.promise);
    const startup = f.start();
    let closed = false;
    const shutdown = f.runtime.close().then(() => { closed = true; });
    try {
      await vi.advanceTimersByTimeAsync(14_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      expect(closed).toBe(true);
    } finally {
      read.resolve([f.released]);
      await startup;
      await shutdown;
      vi.useRealTimers();
    }
    expect(f.store.claim).not.toHaveBeenCalled();
  });

  it("returns a startup claim only when the protected launch was never attempted", async () => {
    const full = recoveryFixture();
    mocks.pool.restoreIdle.mockRejectedValueOnce(new Error("pool at capacity"));
    await full.start();
    expect(full.launchProtected).not.toHaveBeenCalled();
    expect(full.store.release).toHaveBeenCalledExactlyOnceWith(full.active);

    const unknown = recoveryFixture();
    unknown.launchProtected.mockImplementationOnce(() => { throw new Error("launch outcome unknown"); });
    mocks.pool.restoreIdle.mockImplementationOnce(async restore => { restore.launchProtected(); });
    await unknown.start();
    expect(unknown.launchProtected).toHaveBeenCalledOnce();
    expect(unknown.store.release).not.toHaveBeenCalled();
  });

  it("saves a fresh verified checkpoint and releases only the resulting active receipt", async () => {
    const f = recoveryFixture();
    f.store.listRecoverable.mockResolvedValueOnce([]);
    await f.start();
    mocks.pool.close.mockImplementationOnce(async onConfirmedHandoff => { await onConfirmedHandoff(f.checkpoint); });
    await f.runtime.close();
    expect(f.store.saveActive).toHaveBeenCalledExactlyOnceWith(f.checkpoint, undefined);
    expect(f.store.release).toHaveBeenCalledExactlyOnceWith({ ...f.checkpoint, status: "active", generation: 1 });
  });

  it.each([true, false])("hands off only jobs that can fire within the native session (eligible job: %s)", async includeEligible => {
    const f = recoveryFixture();
    f.store.listRecoverable.mockResolvedValueOnce([]);
    const now = Date.now();
    const soon = { ...job, replay: {
      toolUseId: "toolu_minutely", assistantMessageId: "msg_schedule",
      prompt, receivedAtMs: now, nextFireAtMs: now + 10_000,
    } };
    const monthlyPrompt = "Run the next monthly check";
    const monthly = {
      ...soon, id: "abcdef02", cron: "0 0 1 * *",
      promptSha256: createHash("sha256").update(monthlyPrompt).digest("hex"),
      receiptUuid: "40c465b2-37e0-4eb4-b51d-d8bef1c69a1c",
      replay: { ...soon.replay, toolUseId: "toolu_monthly", prompt: monthlyPrompt,
        nextFireAtMs: Date.parse(f.checkpoint.deadlineAt) + 86_400_000 },
    };
    const checkpoint = { ...f.checkpoint, jobs: includeEligible ? [monthly, soon] : [monthly] };
    let transcript: Buffer | undefined;
    f.host.checkpointAfterClose.mockImplementationOnce(async candidate => {
      transcript = buildClaudeNativeReplayJsonl({ sessionId: candidate.sessionId, root: "/owner", nowMs: now,
        deadlineMs: Date.parse(candidate.deadlineAt), jobs: candidate.jobs });
      return true;
    });
    await f.start();
    mocks.pool.close.mockImplementationOnce(async onConfirmedHandoff => { await onConfirmedHandoff(checkpoint); });
    await f.runtime.close();
    if (!includeEligible) {
      expect(f.host.checkpointAfterClose).not.toHaveBeenCalled();
      expect(f.store.saveActive).not.toHaveBeenCalled();
      expect(f.store.release).not.toHaveBeenCalled();
      return;
    }
    expect(transcript?.toString("utf8")).toContain("Scheduled recurring job abcdef01.");
    expect(transcript?.toString("utf8")).not.toContain(monthlyPrompt);
    const expected = { ...checkpoint, jobs: [soon] };
    expect(f.store.saveActive).toHaveBeenCalledExactlyOnceWith(expected, undefined);
    expect(f.store.release).toHaveBeenCalledExactlyOnceWith({ ...expected, status: "active", generation: 1 });
  });

  it("permits a separately verified newer session to supersede an old local claim", async () => {
    const f = recoveryFixture();
    await f.start();
    const checkpoint = { ...f.checkpoint, sourceRunId: "run_b", sessionId: "d24c62c8-0243-41f1-b018-fdb274b409be" };
    f.store.saveActive.mockResolvedValueOnce({ ...checkpoint, status: "active", generation: 4 });
    mocks.pool.close.mockImplementationOnce(async onConfirmedHandoff => { await onConfirmedHandoff(checkpoint); });
    await f.runtime.close();
    expect(f.store.saveActive).toHaveBeenCalledExactlyOnceWith(checkpoint, undefined);
    expect(f.store.release).toHaveBeenCalledExactlyOnceWith({ ...checkpoint, status: "active", generation: 4 });
  });

  it("refuses to replace a claim when the same session loses its source binding", async () => {
    const f = recoveryFixture();
    await f.start();
    const checkpoint = { ...f.checkpoint, sourceFingerprint: "b".repeat(64) };
    mocks.pool.close.mockImplementationOnce(async onConfirmedHandoff => { await onConfirmedHandoff(checkpoint); });
    await f.runtime.close();
    expect(f.host.checkpointAfterClose).not.toHaveBeenCalled();
    expect(f.store.saveActive).not.toHaveBeenCalled();
    expect(f.store.release).not.toHaveBeenCalled();
  });

  it("only releases a recovery snapshot after confirmed cleanup and a protected checkpoint", async () => {
    const f = recoveryFixture();
    await f.start();
    mocks.pool.close.mockImplementationOnce(async onConfirmedHandoff => {
      expect(f.host.checkpointAfterClose).not.toHaveBeenCalled();
      expect(f.store.release).not.toHaveBeenCalled();
      await onConfirmedHandoff(f.checkpoint);
    });
    await Promise.all([f.runtime.close(), f.runtime.close()]);
    expect(mocks.pool.close).toHaveBeenCalledOnce();
    expect(f.host.checkpointAfterClose).toHaveBeenCalledExactlyOnceWith(f.checkpoint, expect.any(AbortSignal));
    expect(f.store.release).toHaveBeenCalledExactlyOnceWith(f.active);

    const unprotected = recoveryFixture();
    await unprotected.start();
    unprotected.host.checkpointAfterClose.mockResolvedValueOnce(false);
    mocks.pool.close.mockImplementationOnce(async onConfirmedHandoff => { await onConfirmedHandoff(unprotected.checkpoint); });
    await unprotected.runtime.close();
    expect(unprotected.store.release).not.toHaveBeenCalled();

    const uncertain = recoveryFixture();
    await uncertain.start();
    mocks.pool.close.mockRejectedValueOnce(new Error("cleanup unknown"));
    await expect(uncertain.runtime.close()).rejects.toThrow("cleanup unknown");
    expect(uncertain.host.checkpointAfterClose).not.toHaveBeenCalled();
    expect(uncertain.store.release).not.toHaveBeenCalled();
  });
});
