import { describe, expect, it, vi } from "vitest";
import { restoreBackgroundChatThread } from "../../packages/gateway/src/coding-agents/background-chat-recovery.js";

const thread = { id: "thread_one", ownerId: "owner", providerId: "codex", providerResumeState: { conversationId: "sess_one" }, providerEventOffset: 42 };
describe("background Chat recovery", () => {
  it("restores the persisted event position under the durable session owner", async () => {
    const watch = vi.fn().mockResolvedValue({ path: "events" });
    const sessions = { getSession: vi.fn().mockResolvedValue({ ok: true, session: { id: "sess_one", ownerId: "owner", agent: "codex", kind: "agent", runtime: { type: "background" }, backgroundRef: { id: "bg_00000000000000000000000000000001" } } }) };
    expect(await restoreBackgroundChatThread({ thread: thread as never, sessions: sessions as never, events: { watch } as never })).toBe(true);
    expect(watch).toHaveBeenCalledWith({ principal: { userId: "owner", source: "jwt" }, threadId: "thread_one", sessionId: "sess_one", startOffset: 42, checkpoint: true });
  });

  it("refuses a foreign owner and a legacy terminal session", async () => {
    const watch = vi.fn();
    for (const session of [{ ownerId: "foreign", runtime: { type: "background" } }, { ownerId: "owner", runtime: { type: "zellij" } }]) {
      const sessions = { getSession: vi.fn().mockResolvedValue({ ok: true, session: { ...session, id: "sess_one", agent: "codex", kind: "agent" } }) };
      expect(await restoreBackgroundChatThread({ thread: thread as never, sessions: sessions as never, events: { watch } as never })).toBe(false);
    }
    expect(watch).not.toHaveBeenCalled();
  });
});

import { createBackgroundChatProjection } from "../../packages/gateway/src/coding-agents/background-chat-recovery.js";

it("releases completed recovery slots while still projecting their final events", async () => {
  vi.useFakeTimers();
  const projection = createBackgroundChatProjection();
  let publish: (event: any) => void = () => {};
  const reconcile = vi.fn().mockResolvedValue(undefined);
  try {
    projection.attach({ registerEventSink: (sink: any) => { publish = sink; return { dispose() {} }; } });
    projection.setReconciler(reconcile);
    for (let i = 0; i < 150; i += 1) {
      const threadId = `thread_${i}`;
      projection.track({ id: threadId, ownerId: "owner" });
      publish({ ownerId: "owner", threadId, events: [{ type: i % 2 ? "thread.completed" : "thread.error" }] });
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcile).toHaveBeenCalledTimes(2);
    publish({ ownerId: "owner", threadId: "thread_149", events: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcile).toHaveBeenCalledTimes(2);
  } finally { await projection.close(); vi.useRealTimers(); }
});

it("runs a fresh replay after joining an older in-flight reconciliation", async () => {
  vi.useFakeTimers();
  const projection = createBackgroundChatProjection();
  let publish: (event: any) => void = () => {};
  let completeOld!: () => void;
  const old = new Promise<void>(resolve => { completeOld = resolve; });
  const reconcile = vi.fn().mockImplementationOnce(() => old).mockResolvedValue(undefined);
  try {
    projection.track(thread);
    projection.attach({ registerEventSink: (sink: any) => { publish = sink; return { dispose() {} }; } });
    projection.setReconciler(reconcile);
    publish({ ownerId: "owner", threadId: "thread_one", events: [] });
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcile).toHaveBeenCalledTimes(1);
    completeOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(2);
  } finally { await projection.close(); vi.useRealTimers(); }
});
