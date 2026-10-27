import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentThreadSummarySchema } from "@matrix-os/contracts";
import { boundedOperation } from "../../packages/gateway/src/bounded-operation.js";
import { proveCodexResumeStopped } from "../../packages/gateway/src/coding-agents/provider-transcript-recovery.js";
import { createSessionStartGuard, SessionStartBusyError } from "../../packages/gateway/src/session-start-guard.js";
import { createWorkspaceSessionOrchestrator, type WorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";
import { createWorkspaceEventPublisher } from "../../packages/gateway/src/workspace-event-publisher.js";
import { createCodingAgentSessionStopReconciler } from "../../packages/gateway/src/coding-agents/session-stop-reconciler.js";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { completionEvents } from "../../packages/gateway/src/coding-agents/codex-terminal-events.js";

const principal = { userId: "owner_proof", source: "jwt" as const };
const backgroundRef = { id: "bg_00000000000000000000000000000001" };
const successorRef = { id: "bg_00000000000000000000000000000002" };
const homes: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "codex-resume-proof-"));
  homes.push(homePath);
  const sessionId = "sess_proof";
  const thread = AgentThreadSummarySchema.parse({ id: "thread_proof", providerId: "codex", title: "proof",
    status: "failed", attention: "failed", createdAt: "2026-10-27T00:00:00.000Z", updatedAt: "2026-10-27T00:00:00.000Z" });
  let session = { id: sessionId, ownerId: principal.userId, kind: "agent" as const, agent: "codex" as const,
    runtime: { type: "background" as const, status: "running" }, backgroundRef };
  const guard = createSessionStartGuard(homePath, async () => true);
  const withSessionStart: WorkspaceSessionOrchestrator["withSessionStart"] = (owner, id, operation) =>
    guard.reserve(id, owner, () => operation({} as never));
  const runtime = {
    getSession: vi.fn(async () => ({ ok: true as const, session: session as never })), withSessionStart,
    stopSession: vi.fn(async () => ({ ok: true as const, session: session as never })),
  };
  const backgroundRuntime = { isRunning: vi.fn(async (_ref: { id: string }) => false), stop: vi.fn(async (_ref: { id: string }) => undefined) };
  const control = { hibernate: vi.fn(async () => undefined) } as unknown as NonNullable<Parameters<typeof proveCodexResumeStopped>[1]["control"]>;
  const input = { principal, thread, resumeState: { conversationId: sessionId, providerThreadId: "native_proof", backgroundRef },
    signal: new AbortController().signal };
  return { input, runtime, control, backgroundRuntime, guard, sessionId, homePath,
    bindThread: (value: typeof thread) => {
      input.thread = value;
      input.resumeState.conversationId = `sess_${value.id.slice("thread_".length)}`;
      session = { ...session, id: input.resumeState.conversationId };
    },
    options: { runtime, control, backgroundRuntime },
    replace: () => { session = { ...session, backgroundRef: successorRef }; },
    markExited: () => { session = { ...session, runtime: { ...session.runtime, status: "exited" } }; } };
}

describe("same-native resume stop proof", () => {
  it("does not enqueue a stop callback against the newly accepted continuation", async () => {
    const f = await fixture();
    const reconciler = createCodingAgentSessionStopReconciler();
    const publishEvent = vi.fn(async () => ({ ok: true as const, event: { id: "evt_session_stopped" } }));
    const callbackTasks: Promise<void>[] = [];
    const eventPublisher = createWorkspaceEventPublisher({ eventStore: { publishEvent },
      onSessionStopped: session => {
        const task = reconciler.handleSessionStopped(session);
        callbackTasks.push(task);
        return task;
      } });
    const runtime = createWorkspaceSessionOrchestrator({
      projectManager: {} as never, worktreeManager: {} as never, sessionRuntimeBridge: {} as never,
      agentSandbox: { cleanup: async () => undefined } as never, eventPublisher,
      agentSessionManager: { ...f.runtime, killSession: async () => { f.markExited(); return f.runtime.getSession(); } } as never,
    });
    const resumeTurn = vi.fn(async () => ({ events: [], outcome: "delivered" as const, resumeState: f.input.resumeState }));
    const threads = createCodingAgentThreadStore({ homePath: f.homePath, providers: [{ providerId: "codex",
      startThread({ thread, now, nextEventId }) {
        f.bindThread(thread);
        return { events: completionEvents({ threadId: thread.id, outcome: "failed", failureReason: "history_unavailable",
          occurredAt: now().toISOString(), nextEventId }), resumeState: f.input.resumeState };
      }, resumeTurn,
      async prepareHistoryResume(input) {
        if (!await proveCodexResumeStopped(input, { ...f.options, runtime })) throw new Error("stop unconfirmed");
      },
    }] });
    try {
      await reconciler.attachThreadStore(threads);
      const created = await threads.createThread(principal, { providerId: "codex", prompt: "original", clientRequestId: "req_original" });
      const accepted = await threads.acceptTurn(principal, created.snapshot.thread.id, { message: "continue", clientRequestId: "req_continue" });
      await Promise.all(callbackTasks);
      await vi.waitFor(() => expect(resumeTurn).toHaveBeenCalledTimes(1));
      const current = await threads.getThread(principal, created.snapshot.thread.id);
      expect(current.events.items.filter(event => event.type === "turn.status" && event.turnId === accepted.turnId))
        .not.toContainEqual(expect.objectContaining({ status: "aborted" }));
      expect(current.thread.status).toBe("running");
      expect(publishEvent).not.toHaveBeenCalled();
    } finally {
      await threads.shutdownTurns();
      await runtime.close();
      reconciler.dispose();
    }
  });

  it("stops and confirms only the retained background reference without publishing a session stop", async () => {
    const f = await fixture();
    expect(await proveCodexResumeStopped(f.input, f.options)).toBe(true);
    expect(f.backgroundRuntime.stop).toHaveBeenCalledWith(backgroundRef);
    expect(f.backgroundRuntime.isRunning).toHaveBeenLastCalledWith(backgroundRef);
    expect(f.runtime.stopSession).not.toHaveBeenCalled();
    expect(f.control.hibernate).not.toHaveBeenCalled();
  });

  it("does not certify stop when the background process is still running after the stop call", async () => {
    const f = await fixture();
    f.backgroundRuntime.isRunning.mockResolvedValue(true);
    expect(await proveCodexResumeStopped(f.input, f.options)).toBe(false);
    expect(f.control.hibernate).toHaveBeenCalledWith(expect.objectContaining({ providerThreadId: "native_proof" }));
    expect(f.backgroundRuntime.stop).toHaveBeenCalledWith(backgroundRef);
  });

  it("does not trust persisted exited status when fresh runtime observation fails", async () => {
    const f = await fixture();
    f.markExited();
    f.backgroundRuntime.isRunning.mockRejectedValue(new Error("runtime status unavailable"));
    await expect(proveCodexResumeStopped(f.input, f.options)).rejects.toThrow("runtime status unavailable");
    expect(f.backgroundRuntime.stop).not.toHaveBeenCalled();
    expect(f.runtime.stopSession).not.toHaveBeenCalled();
  });

  it("keeps the runtime reservation until a timed-out proof settles and cannot stop its successor", async () => {
    const f = await fixture();
    const observed = deferred<boolean>();
    const entered = deferred<void>();
    f.backgroundRuntime.isRunning.mockImplementationOnce(() => { entered.resolve(); return observed.promise; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pending!: Promise<boolean>;
    const bounded = boundedOperation(signal => (pending = proveCodexResumeStopped({ ...f.input, signal }, f.options)), 100);
    const outcome = bounded.then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ error: expect.any(Error) });
    await expect(f.guard.reserve(f.sessionId, principal.userId, async () => f.replace())).rejects.toBeInstanceOf(SessionStartBusyError);
    observed.resolve(false);
    await expect(pending).rejects.toThrow();
    await f.guard.reserve(f.sessionId, principal.userId, async () => f.replace());
    expect(f.backgroundRuntime.stop).not.toHaveBeenCalled();
    expect(f.runtime.stopSession).not.toHaveBeenCalled();
    expect((await f.runtime.getSession()).session).toMatchObject({ backgroundRef: successorRef });
  });
});
