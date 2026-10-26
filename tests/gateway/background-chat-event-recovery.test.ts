import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { restoreBackgroundChatThread } from "../../packages/gateway/src/coding-agents/background-chat-recovery.js";
import { recoverCodingRun } from "../../packages/gateway/src/chat/coding-run-recovery.js";

const principal = { userId: "owner", source: "jwt" as const };
const backgroundRef = { id: "bg_00000000000000000000000000000001" };
async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "background-chat-recovery-"));
  const provider = {
    providerId: "codex",
    abortThread: vi.fn(),
    startThread: vi.fn(({ thread }: { thread: { id: string } }) => ({ events: [], resumeState: { conversationId: `sess_${thread.id.slice(7)}`, backgroundRef } })),
    resumeTurn: vi.fn(),
  };
  const store = createCodingAgentThreadStore({ homePath, providers: [provider as never] });
  const created = await store.createThread(principal, { providerId: "codex", prompt: "test", clientRequestId: "req_first" });
  const threadId = created.snapshot.thread.id;
  const sessionId = `sess_${threadId.slice(7)}`;
  let clock = 0;
  const bridgeOptions = { homePath, nowMs: () => clock, pollIntervalMs: 60_000, runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }), isRuntimeAlive: async () => true };
  return { homePath, provider, store, threadId, sessionId, bridgeOptions, setClock: (value: number) => { clock = value; } };
}

describe("background Chat durable observation", () => {
  it("settles a shortened transcript only after its exact backing runner confirms idle without replaying output", async () => {
    const f = await fixture();
    const isExecutionIdle = vi.fn().mockResolvedValue(true);
    const bridge = createCodexEventBridge({ ...f.bridgeOptions, isExecutionIdle });
    try {
      bridge.attachThreadStore(f.store);
      const path = codexProviderEventPath(f.homePath, f.sessionId);
      await bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId, checkpoint: true });
      const output = "already committed ".repeat(30);
      await writeFile(path, [
        { type: "thread.started", thread_id: "native_current" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "msg_first", type: "agent_message", text: output } },
      ].map(record => JSON.stringify(record)).join("\n") + "\n");
      await bridge.drain();
      expect((await f.store.getThread(principal, f.threadId)).thread.status).toBe("running");
      await writeFile(path, JSON.stringify({ type: "thread.started", thread_id: "native_current" }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n");
      await bridge.drain();
      const snapshot = await f.store.getThread(principal, f.threadId);
      expect(snapshot.thread.status).toBe("failed");
      expect(snapshot.events.items.filter(event => event.type === "assistant.text.delta").map(event => event.delta)).toEqual([output]);
      expect(snapshot.events.items.filter(event => event.type === "thread.completed")).toHaveLength(1);
      expect(isExecutionIdle).toHaveBeenCalledWith({ ownerId: principal.userId, backgroundRefId: backgroundRef.id,
        sessionId: f.sessionId, providerThreadId: "native_current" });
      const recovered = await recoverCodingRun({ runId: "run_first", state: { conversationId: f.threadId },
        signal: AbortSignal.timeout(1000), includePending: true,
        read: cursor => f.store.getThread(principal, f.threadId, cursor) });
      expect(recovered?.outcome).toBe("failed");
      expect(recovered?.messages.map(message => message.text)).toEqual([output]);
      await expect(f.store.acceptTurn(principal, f.threadId, { message: "continue", clientRequestId: "req_after_drift" }))
        .rejects.toMatchObject({ code: "thread_not_resumable" });
      expect(f.provider.resumeTurn).not.toHaveBeenCalled();
      await bridge.drain();
      expect((await f.store.getThread(principal, f.threadId)).events.items.filter(event => event.type === "thread.completed")).toHaveLength(1);
    } finally { await f.store.shutdownTurns(); await bridge.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
  });

  it("protects a shortened live or unknown transcript until the same request has an idle proof", async () => {
    const f = await fixture();
    const isExecutionIdle = vi.fn().mockResolvedValue(false);
    const bridge = createCodexEventBridge({ ...f.bridgeOptions, isExecutionIdle });
    try {
      bridge.attachThreadStore(f.store);
      const path = codexProviderEventPath(f.homePath, f.sessionId);
      await bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId, checkpoint: true });
      await writeFile(path, [
        { type: "thread.started", thread_id: "native_current" }, { type: "turn.started" },
        { type: "item.completed", item: { id: "msg_first", type: "agent_message", text: "preserved ".repeat(40) } },
      ].map(record => JSON.stringify(record)).join("\n") + "\n");
      await bridge.drain();
      await writeFile(path, '{"type":"turn.completed"}\n');
      await bridge.drain();
      expect((await f.store.getThread(principal, f.threadId)).thread.status).toBe("running");
      await bridge.drain();
      expect(isExecutionIdle).toHaveBeenCalledTimes(1);
      f.setClock(10_000);
      isExecutionIdle.mockResolvedValue(true);
      await bridge.drain();
      expect((await f.store.getThread(principal, f.threadId)).thread.status).toBe("failed");
    } finally { await bridge.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
  });

  it("recovers a shortened transcript after restart without dispatching its prompt again", async () => {
    const f = await fixture();
    const bridge = createCodexEventBridge(f.bridgeOptions);
    const restarted = createCodexEventBridge({ ...f.bridgeOptions, isExecutionIdle: async () => true });
    try {
      bridge.attachThreadStore(f.store);
      const path = codexProviderEventPath(f.homePath, f.sessionId);
      await bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId, checkpoint: true });
      const output = "preserved across restart ".repeat(30);
      await writeFile(path, [
        { type: "thread.started", thread_id: "native_current" }, { type: "turn.started" },
        { type: "item.completed", item: { id: "msg_first", type: "agent_message", text: output } },
      ].map(record => JSON.stringify(record)).join("\n") + "\n");
      await bridge.drain();
      await bridge.shutdown();
      await writeFile(path, '{"type":"turn.completed"}\n');
      const recovered = createCodingAgentThreadStore({ homePath: f.homePath, providers: [f.provider as never],
        restoreProviderThread: thread => restoreBackgroundChatThread({ thread, events: restarted,
          sessions: { getSession: async () => ({ ok: true, session: { id: f.sessionId, ownerId: principal.userId,
            kind: "agent", agent: "codex", runtime: { type: "background" }, backgroundRef } }) } as never }) });
      restarted.attachThreadStore(recovered);
      await recovered.recoverActiveTurns();
      await restarted.drain();
      const snapshot = await recovered.getThread(principal, f.threadId);
      expect(snapshot.thread.status).toBe("failed");
      expect(snapshot.events.items.filter(event => event.type === "assistant.text.delta").map(event => event.delta)).toEqual([output]);
      expect(snapshot.events.items.find(event => event.type === "thread.error")).toMatchObject({ error: { code: "agent_history_unavailable", retryable: false } });
      expect(f.provider.startThread).toHaveBeenCalledTimes(1);
      expect(f.provider.resumeTurn).not.toHaveBeenCalled();
    } finally { await bridge.shutdown(); await restarted.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
  });

  it("rejects stale checkpoint, foreign owner, and newer accepted turn recovery before querying native idle", async () => {
    const f = await fixture();
    const bridge = createCodexEventBridge(f.bridgeOptions);
    const proveIdle = vi.fn().mockResolvedValue(true);
    let finish: (() => void) | undefined;
    try {
      bridge.attachThreadStore(f.store);
      const path = codexProviderEventPath(f.homePath, f.sessionId);
      await bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId, checkpoint: true });
      const prefix = '{"type":"thread.started","thread_id":"native_current"}\n{"type":"turn.started"}\n';
      await writeFile(path, prefix);
      await bridge.drain();
      const offset = Buffer.byteLength(prefix);
      const cursor = { sessionId: f.sessionId, expectedOffset: offset };
      await expect(f.store.recoverProviderTranscript({ ...principal, userId: "foreign" }, f.threadId, cursor, proveIdle)).resolves.toBe(false);
      await expect(f.store.recoverProviderTranscript(principal, f.threadId, { ...cursor, sessionId: "sess_foreign" }, proveIdle)).resolves.toBe(false);
      await expect(f.store.recoverProviderTranscript(principal, f.threadId, { ...cursor, expectedOffset: offset - 1 }, proveIdle)).resolves.toBe(false);
      await appendFile(path, '{"type":"turn.completed"}\n');
      await bridge.drain();
      f.provider.resumeTurn.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ events: [], outcome: "completed" }); }));
      await f.store.acceptTurn(principal, f.threadId, { message: "a newer accepted task", clientRequestId: "req_newer" });
      await expect(f.store.recoverProviderTranscript(principal, f.threadId,
        { ...cursor, expectedOffset: offset + Buffer.byteLength('{"type":"turn.completed"}\n') }, proveIdle)).resolves.toBe(false);
      expect(proveIdle).not.toHaveBeenCalled();
      expect((await f.store.getThread(principal, f.threadId)).thread.status).not.toBe("failed");
    } finally { finish?.(); await f.store.shutdownTurns(); await bridge.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
  });

  it("restarts the event bridge from the atomically committed byte position without replaying text", async () => {
    const f = await fixture();
    const bridge = createCodexEventBridge(f.bridgeOptions);
    let restarted: ReturnType<typeof createCodexEventBridge> | undefined;
    try {
      bridge.attachThreadStore(f.store);
      const path = codexProviderEventPath(f.homePath, f.sessionId);
      await expect(bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId, checkpoint: true })).resolves.toEqual({ path, offset: 0 });
      await expect(bridge.watch({ principal, threadId: f.threadId, sessionId: f.sessionId })).resolves.toEqual({ path });
      const first = JSON.stringify({ type: "item.completed", item: { id: "msg_first", type: "agent_message", text: "first part" } }) + "\n";
      await writeFile(path, first);
      await bridge.drain();
      const saved = JSON.parse(await readFile(join(f.homePath, "system/coding-agents/threads.json"), "utf8"));
      expect(saved.threads[0].providerEventOffset).toBe(Buffer.byteLength(first));
      await bridge.shutdown();
      restarted = createCodexEventBridge(f.bridgeOptions);
      const events = restarted;
      const recovered = createCodingAgentThreadStore({ homePath: f.homePath, providers: [f.provider as never], restoreProviderThread: thread => restoreBackgroundChatThread({ thread, events, sessions: { getSession: async () => ({ ok: true, session: { id: f.sessionId, ownerId: principal.userId, kind: "agent", agent: "codex", runtime: { type: "background" }, backgroundRef } }) } as never }) });
      restarted.attachThreadStore(recovered);
      await recovered.recoverActiveTurns();
      expect(restarted.watcherCount()).toBe(1);
      f.setClock(600_000);
      await restarted.drain();
      expect((await recovered.getThread(principal, f.threadId)).thread.status).not.toBe("failed");
      await appendFile(path, JSON.stringify({ type: "item.completed", item: { id: "msg_second", type: "agent_message", text: "second part" } }) + "\n" + JSON.stringify({ type: "turn.completed" }) + "\n");
      await restarted.drain();
      const snapshot = await recovered.getThread(principal, f.threadId);
      expect(snapshot.events.items.filter(event => event.type === "assistant.text.delta").map(event => event.delta)).toEqual(["first part", "second part"]);
      expect(snapshot.thread.status).toBe("completed");
    } finally { await bridge.shutdown(); await restarted?.shutdown(); await rm(f.homePath, { recursive: true, force: true }); }
  });

  it("ignores a stale background stop and settles only the current incarnation", async () => {
    const f = await fixture();
    try {
      await f.store.reconcileBackgroundSessionStopped({ ownerId: principal.userId, workspaceSessionId: f.sessionId, backgroundRef: { id: "bg_00000000000000000000000000000002" }, runtimeStatus: "failed" });
      expect((await f.store.getThread(principal, f.threadId)).thread.status).toBe("queued");
      await f.store.reconcileBackgroundSessionStopped({ ownerId: principal.userId, workspaceSessionId: f.sessionId, backgroundRef, runtimeStatus: "failed" });
      expect((await f.store.getThread(principal, f.threadId)).thread.status).toBe("failed");
    } finally { await rm(f.homePath, { recursive: true, force: true }); }
  });
});


it("requires confirmed stop for the exact recovered canonical request", async () => {
  const f = await fixture();
  try {
    await f.store.abortThread(principal, f.threadId, "req_stale_cancel", { runRequestId: "req_other" });
    expect(f.provider.abortThread).not.toHaveBeenCalled();
    f.provider.abortThread.mockRejectedValueOnce(new Error("stop unconfirmed"));
    await expect(f.store.abortThread(principal, f.threadId, "req_cancel", { runRequestId: "req_first" })).rejects.toThrow("stop unconfirmed");
    expect(f.provider.abortThread).toHaveBeenCalledWith(expect.objectContaining({ requireRuntimeStop: true }));
    expect((await f.store.getThread(principal, f.threadId)).thread.status).toBe("queued");
    f.provider.abortThread.mockImplementationOnce(({ thread, now, nextEventId }) => [{ type: "thread.completed", threadId: thread.id, eventId: nextEventId(), occurredAt: now().toISOString(), outcome: "aborted" }]);
    await f.store.abortThread(principal, f.threadId, "req_cancel", { runRequestId: "req_first" });
    expect((await f.store.getThread(principal, f.threadId)).thread.status).toBe("aborted");
  } finally { await rm(f.homePath, { recursive: true, force: true }); }
});

import { applyThreadAbort } from "../../packages/gateway/src/coding-agents/thread-abort.js";
it("does not report successful cancellation when a live turn's retained identity is missing", async () => {
  await expect(applyThreadAbort({
    principal, clientRequestId: "req_stop", scope: { runRequestId: "req_current" },
    thread: { id: "thread_one", ownerId: "owner", deliveredTurnId: "turn_evicted", clientRequestId: "req_first" } as never,
    state: { turns: [] } as never,
  }, { snapshotFor: () => ({}) } as never)).rejects.toThrow("identity");
});
