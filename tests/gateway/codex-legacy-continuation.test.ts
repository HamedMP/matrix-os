import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { createCodexExecutionAdmission } from "../../packages/gateway/src/coding-agents/codex-execution-admission.js";
import { bindNativeAccountMetadata } from "../../packages/gateway/src/ai-providers/native-account-metadata-binding.js";
import { createWorkspaceCodingAgentProvider } from "../../packages/gateway/src/coding-agents/workspace-provider.js";
import { markSessionStopConfirmed } from "../../packages/gateway/src/coding-agents/session-start-cleanup-proof.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "codex-legacy-continuation-")); homes.push(homePath);
  const settingsPath = join(homePath, "system/ai-providers/settings.json");
  const principal = "private-account-A";
  let authenticated = true;
  await mkdir(join(homePath, "system/ai-providers"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ schemaVersion: 1, revision: 1, harnesses: [{
    id: "codex", driverId: "codex", harness: "codex", displayName: "Codex", accentColor: null, enabled: true,
    selectedAccountId: "owner_codex", accessSourceId: "owner_openai_profile",
    nativeAccountGeneration: createHash("sha256").update(principal).digest("hex"), nativeAccountConsentRevision: 1,
    route: { kind: "fixed", providerId: "openai", modelId: "provider-default" },
  }], accountProfiles: [], gatewayPolicy: null, receipts: [] }));
  const stopSession = vi.fn(async () => undefined);
  const admissionOptions = {
    homePath, isOwner: id => id === "owner",
    stopSession,
    getSnapshot: async () => ({ revision: 1, access: { mode: "writable" },
      accessSources: [{ id: "owner_openai_profile", providerId: "openai", accountId: "owner_codex", kind: "provider_account", fundingKind: "owner_account" }],
      accounts: [{ id: "owner_codex", providerId: "openai", accessSourceId: "owner_openai_profile", authMethod: "terminal", authState: "authenticated" }],
    } as unknown as ProviderSettingsSnapshot),
    readNativeAccount: async () => bindNativeAccountMetadata({ accountLabel: "owner@example.test", authMethod: "terminal",
      checkedAt: new Date(Date.now() - 1_000).toISOString(), staleAfter: new Date(Date.now() + 30_000).toISOString(),
    }, async () => authenticated, principal),
  } satisfies Parameters<typeof createCodexExecutionAdmission>[0];
  const admission = createCodexExecutionAdmission(admissionOptions);
  const session = { id: "sess_legacy", ownerId: "owner", kind: "agent", agent: "codex", projectSlug: "repo",
    backgroundRef: { id: `bg_${"a".repeat(32)}` }, runtime: { type: "background", status: "degraded", createdAt: "2026-01-01T00:00:00.000Z" } };
  const confirmStoppedSession = vi.fn(async () => markSessionStopConfirmed({}, "owner", session.id));
  const publishEvents = vi.fn(async (_batch: unknown) => true);
  const startSession = vi.fn(async () => ({ ok: true, status: 201, session: {
    ...session, backgroundRef: { id: `bg_${"b".repeat(32)}` }, runtime: { ...session.runtime, status: "running" },
  } }));
  const runtime = { startSession, stopSession: vi.fn(), getSession: vi.fn(async () => ({ ok: true, session })),
    confirmStoppedSession, withSessionStart: vi.fn(async (_owner: string, _session: string, run: (scope: unknown) => Promise<unknown>) =>
      run({ startSession, cleanFailure: vi.fn(async (result: unknown) => result) })) };
  const submitTurn = vi.fn();
  const events = { healthCheck: vi.fn(), watch: vi.fn(async () => ({ offset: 42 })), unwatch: vi.fn(), markStopped: vi.fn() };
  const control = { submitTurn, hibernate: undefined as undefined | ReturnType<typeof vi.fn> };
  const makeProvider = () => createWorkspaceCodingAgentProvider({ providerId: "codex", agent: "codex", runtime: runtime as never,
    codexAdmission: createCodexExecutionAdmission(admissionOptions), codexEvents: events, codexControl: control as never });
  const provider = makeProvider();
  const context = { principal: { userId: "owner", source: "jwt" as const },
    thread: { id: "thread_legacy", providerId: "codex", title: "Old Chat", status: "running", attention: "none",
      projectId: "repo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    turn: { turnId: "turn_followup", message: "Continue the old conversation", model: "gpt-6-sol", sandboxMode: "full_access" },
    resumeState: { conversationId: "sess_legacy", providerThreadId: "native_legacy", backgroundRef: session.backgroundRef },
    signal: new AbortController().signal, publishEvents, now: () => new Date(), nextEventId: () => "evt_recovered" };
  const resume = (override = {}) => provider.resumeTurn!({ ...context, ...override } as never);
  return { homePath, admission, provider, makeProvider, runtime, startSession, confirmStoppedSession, events, control, submitTurn, publishEvents, context, resume, stopSession,
    revoke: () => { authenticated = false; } };
}

describe("old Codex Chat continuation", () => {
  it("reauthorizes a stopped legacy process and resumes the same native conversation with only the new prompt", async () => {
    const f = await fixture();
    const result = await f.resume();
    expect(result).toMatchObject({ outcome: "delivered", resumeState: {
      nativeAccountBinding: expect.any(String), providerThreadId: "native_legacy", conversationId: "sess_legacy",
      backgroundRef: { id: `bg_${"b".repeat(32)}` },
    } });
    expect(f.confirmStoppedSession).toHaveBeenCalledWith("owner", "sess_legacy", f.context.resumeState.backgroundRef);
    expect(f.startSession).toHaveBeenCalledTimes(1);
    expect(f.startSession).toHaveBeenCalledWith(expect.objectContaining({ recoveryThreadId: "thread_legacy", request: expect.objectContaining({
      providerThreadId: "native_legacy", prompt: "Continue the old conversation", model: "gpt-6-sol", sandboxMode: "full_access",
    }) }));
    expect(f.submitTurn).not.toHaveBeenCalled();
    expect(f.publishEvents).toHaveBeenCalledWith(expect.objectContaining({ events: [], resumeState: expect.objectContaining({ nativeAccountBinding: expect.any(String) }) }));
    expect(f.publishEvents.mock.invocationCallOrder[0]).toBeLessThan(f.startSession.mock.invocationCallOrder[0]!);
    const index = JSON.parse(await readFile(join(f.homePath, "system/ai-providers/codex-execution-sessions.json"), "utf8"));
    expect(index).toEqual([expect.objectContaining({ sessionId: "sess_legacy", binding: result.resumeState!.nativeAccountBinding })]);
  });

  it.each(["alive", "unknown", "foreign-proof"])("does not authorize or dispatch a legacy process with %s stop evidence", async mode => {
    const f = await fixture();
    if (mode === "unknown") f.confirmStoppedSession.mockRejectedValueOnce(new Error("probe failed"));
    else f.confirmStoppedSession.mockResolvedValueOnce(mode === "foreign-proof" ? markSessionStopConfirmed({}, "other", "sess_legacy") : {});
    await expect(f.resume()).rejects.toThrow();
    expect(f.startSession).not.toHaveBeenCalled(); expect(f.submitTurn).not.toHaveBeenCalled(); expect(f.publishEvents).not.toHaveBeenCalled();
  });

  it("does not replace an existing mismatched binding", async () => {
    const f = await fixture();
    await expect(f.resume({ resumeState: { ...f.context.resumeState, nativeAccountBinding: "f".repeat(64) } })).rejects.toThrow("unavailable");
    expect(f.confirmStoppedSession).not.toHaveBeenCalled(); expect(f.startSession).not.toHaveBeenCalled();
  });

  it("rechecks account authority after observing the stopped process", async () => {
    const f = await fixture();
    f.confirmStoppedSession.mockImplementationOnce(async () => { f.revoke(); return markSessionStopConfirmed({}, "owner", "sess_legacy"); });
    await expect(f.resume()).rejects.toThrow("unavailable");
    expect(f.startSession).not.toHaveBeenCalled(); expect(f.publishEvents).not.toHaveBeenCalled();
  });

  it("hibernates only the exact idle conversation before verifying its process has exited", async () => {
    const f = await fixture();
    f.confirmStoppedSession.mockResolvedValueOnce(undefined as never);
    f.control.hibernate = vi.fn(async () => undefined);
    await expect(f.resume()).resolves.toMatchObject({ outcome: "delivered" });
    expect(f.control.hibernate).toHaveBeenCalledWith({ sessionId: "sess_legacy", providerThreadId: "native_legacy", clientRequestId: "req_legacy_turn_followup" });
    expect(f.confirmStoppedSession).toHaveBeenCalledTimes(2);
  });

  it("leaves busy or unrecognized live runners untouched", async () => {
    const f = await fixture();
    f.confirmStoppedSession.mockResolvedValueOnce(undefined as never);
    f.control.hibernate = vi.fn(async () => { throw new Error("idle boundary rejected"); });
    await expect(f.resume()).rejects.toThrow("idle boundary rejected");
    expect(f.runtime.stopSession).not.toHaveBeenCalled(); expect(f.startSession).not.toHaveBeenCalled(); expect(f.publishEvents).not.toHaveBeenCalled();
  });

  it("never dispatches when saving the recovered binding fails", async () => {
    const f = await fixture();
    f.publishEvents.mockRejectedValueOnce(new Error("persistence unavailable"));
    await expect(f.resume()).rejects.toThrow("persistence unavailable");
    expect(f.startSession).not.toHaveBeenCalled(); expect(f.events.unwatch).toHaveBeenCalledWith("sess_legacy");
  });

  it("does not dispatch if the accepted turn ended before binding persistence", async () => {
    const f = await fixture();
    f.publishEvents.mockResolvedValueOnce(false);
    await expect(f.resume()).rejects.toThrow("persistence");
    expect(f.startSession).not.toHaveBeenCalled();
  });

  it("retains history and the recovered binding across reload, duplicate requests and prolonged inactivity", async () => {
    const f = await fixture();
    const statePath = join(f.homePath, "system/coding-agents/threads.json");
    await mkdir(join(f.homePath, "system/coding-agents"), { recursive: true });
    const timestamp = "2026-01-01T00:00:00.000Z";
    await writeFile(statePath, JSON.stringify({ version: 1, threads: [{ ...f.context.thread, status: "completed", ownerId: "owner",
      clientRequestId: "req_legacy_initial", providerResumeState: f.context.resumeState }], turns: [], pendingTerminalStops: [], events: [{
      type: "assistant.text.delta", eventId: "evt_retained", threadId: "thread_legacy", occurredAt: timestamp,
      messageId: "msg_retained", delta: "The original conversation is retained.",
    }] }));
    const createStore = () => createCodingAgentThreadStore({ homePath: f.homePath, providers: [f.makeProvider()],
      relationValidator: { validateCreate: async () => undefined, validateThread: async () => undefined } });
    let store = createStore();
    const request = { message: "Continue with my original context", clientRequestId: "req_legacy_followup" };
    try {
      const accepted = await store.acceptTurn(f.context.principal, "thread_legacy", request);
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        expect(state.turns.find((t: { turnId: string }) => t.turnId === accepted.turnId)?.status).toBe("completed");
      });
      expect(f.startSession).toHaveBeenCalledTimes(1);
      await store.ingestProviderEvents(f.context.principal, "thread_legacy", { events: [{
        type: "thread.completed", eventId: "evt_recovery_complete", threadId: "thread_legacy", occurredAt: new Date().toISOString(), outcome: "completed",
      }] });
      await store.shutdownTurns();
      const indexPath = join(f.homePath, "system/ai-providers/codex-execution-sessions.json");
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      for (const entry of index) entry.expiresAt = Date.now() - 60 * 24 * 60 * 60 * 1_000;
      await writeFile(indexPath, JSON.stringify(index));
      store = createStore();
      expect((await store.acceptTurn(f.context.principal, "thread_legacy", request)).status).toBe("already_accepted");
      expect(f.startSession).toHaveBeenCalledTimes(1);
      await store.acceptTurn(f.context.principal, "thread_legacy", { message: "Continue after two months", clientRequestId: "req_later" });
      await vi.waitFor(() => expect(f.submitTurn).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => {
        const state = JSON.parse(await readFile(statePath, "utf8"));
        expect(state.turns.find((t: { clientRequestId: string }) => t.clientRequestId === "req_later")?.status).toBe("completed");
        expect(state.threads[0].providerResumeState.nativeAccountBinding).toEqual(expect.any(String));
        expect(state.threads[0].providerResumeState.providerThreadId).toBe("native_legacy");
        expect(state.events).toContainEqual(expect.objectContaining({ eventId: "evt_retained", delta: "The original conversation is retained." }));
      });
      expect(f.confirmStoppedSession).toHaveBeenCalledTimes(1);
      expect(f.startSession).toHaveBeenCalledTimes(1);
      expect(f.stopSession).toHaveBeenCalledWith("sess_legacy");
    } finally { await store.shutdownTurns(); }
  });
});
