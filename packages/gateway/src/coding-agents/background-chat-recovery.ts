import type { StoredThread } from "./thread-store.js";
import type { CodexEventBridge } from "./codex-event-bridge.js";
import type { WorkspaceSessionOrchestrator } from "../domains/workspace/workspace-session-orchestrator.js";
import { BackgroundAgentRefSchema } from "../domains/sessions/background-agent-runtime.js";

/** Restore observation only: never replay a prompt whose delivery is uncertain. */
export async function restoreBackgroundChatThread(options: {
  thread: StoredThread;
  sessions: Pick<WorkspaceSessionOrchestrator, "getSession">;
  events: Pick<CodexEventBridge, "watch">;
}): Promise<boolean> {
  const { thread } = options;
  if (thread.providerId !== "codex") return false;
  const sessionId = `sess_${thread.id.slice("thread_".length)}`;
  if (thread.providerResumeState?.conversationId !== sessionId) return false;
  const current = await options.sessions.getSession(sessionId);
  if (!current.ok || current.session.id !== sessionId || current.session.ownerId !== thread.ownerId
    || current.session.kind !== "agent" || current.session.agent !== "codex"
    || current.session.projectSlug !== thread.projectId || current.session.runtime.type !== "background") return false;
  BackgroundAgentRefSchema.parse(current.session.backgroundRef);
  await options.events.watch({
    principal: { userId: thread.ownerId, source: "jwt" }, threadId: thread.id, sessionId,
    startOffset: Math.max(thread.providerEventOffset ?? 0, thread.providerResumeState.eventOffset ?? 0),
    checkpoint: true,
  });
  return true;
}

/** Coalesce restored-provider updates into canonical replay; no prompt is dispatched here. */
export function createBackgroundChatProjection() {
  const restored = new Set<string>(); // at most 100 active recoveries; terminal events evict, close drains
  const dirty = new Set<string>(); // at most 64 owners; removed after each successful replay
  let reconcile: ((ownerId: string) => Promise<unknown>) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;
  let disposed = false;
  let subscription: { dispose(): void } | undefined;

  function schedule() {
    if (disposed || timer || pending || !reconcile || dirty.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      pending = (async () => {
        const owners = [...dirty];
        for (const owner of owners) {
          dirty.delete(owner);
          try {
            // The first call may join an older owner reconciliation that read
            // before this event. A second call starts after that promise drains.
            await reconcile!(owner);
            if (!disposed) await reconcile!(owner);
          }
          catch (error: unknown) {
            dirty.add(owner);
            console.warn("[background-chat] projection retry", error instanceof Error ? error.name : "UnknownError");
          }
        }
      })().finally(() => { pending = undefined; schedule(); });
    }, 500);
    timer.unref();
  }
  return {
    track(thread: Pick<StoredThread, "id" | "ownerId">) {
      if (disposed) return;
      const key = `${thread.ownerId}:${thread.id}`;
      if (!restored.has(key) && restored.size >= 100) throw new Error("Background recovery capacity reached");
      restored.add(key);
    },
    attach(store: Pick<import("./thread-store.js").CodingAgentThreadStore, "registerEventSink">) {
      subscription?.dispose();
      subscription = store.registerEventSink(({ ownerId, threadId, events }) => {
        const key = `${ownerId}:${threadId}`;
        if (!restored.has(key)) return;
        if (!dirty.has(ownerId) && dirty.size >= 64) throw new Error("Background projection capacity reached");
        dirty.add(ownerId);
        // Keep the owner dirty so the final result is replayed, then release
        // only this finished thread's observation slot for later recoveries.
        if (events.some(event => event.type === "thread.completed" || event.type === "thread.error")) {
          restored.delete(key);
        }
        schedule();
      });
    },
    setReconciler(callback: (ownerId: string) => Promise<unknown>) { reconcile = callback; schedule(); },
    async close() {
      disposed = true;
      subscription?.dispose();
      if (timer) clearTimeout(timer);
      await pending;
      restored.clear();
      dirty.clear();
    },
  };
}
