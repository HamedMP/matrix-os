import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { createCodingAgentThreadStore } from "../../packages/gateway/src/coding-agents/thread-store.js";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { restoreBackgroundChatThread } from "../../packages/gateway/src/coding-agents/background-chat-recovery.js";

const principal = { userId: "owner", source: "jwt" as const };
const backgroundRef = { id: "bg_00000000000000000000000000000001" };
async function fixture() {
  const homePath = await mkdtemp(join(tmpdir(), "background-chat-recovery-"));
  const provider = {
    providerId: "codex",
    abortThread: vi.fn(),
    startThread: ({ thread }: { thread: { id: string } }) => ({ events: [], resumeState: { conversationId: `sess_${thread.id.slice(7)}`, backgroundRef } }),
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
