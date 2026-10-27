import { describe, expect, it, vi } from "vitest";
import { restoreBackgroundChatThread } from "../../packages/gateway/src/coding-agents/background-chat-recovery.js";
import { createCodexExecutionIdleProof } from "../../packages/gateway/src/coding-agents/codex-execution-observation.js";

const thread = { id: "thread_one", ownerId: "owner", providerId: "codex", providerResumeState: { conversationId: "sess_one" }, providerEventOffset: 42 };
it("requires the same owner and background incarnation before and after native idle proof", async () => {
  const session = { id: "sess_one", ownerId: "owner", kind: "agent", agent: "codex", runtime: { type: "background" },
    backgroundRef: { id: "bg_00000000000000000000000000000001" } };
  const observation = { ownerId: "owner", sessionId: "sess_one", backgroundRefId: session.backgroundRef.id,
    providerThreadId: "native_one", requestId: "req_latest" };
  const getSession = vi.fn().mockResolvedValue({ ok: true, session });
  const isExecutionIdle = vi.fn().mockResolvedValue(true);
  const prove = createCodexExecutionIdleProof({ sessions: () => ({ getSession }) as never, control: { isExecutionIdle } });
  expect(await prove(observation)).toBe(true);
  expect(isExecutionIdle).toHaveBeenCalledWith(observation);
  isExecutionIdle.mockClear();
  getSession.mockResolvedValueOnce({ ok: true, session: { ...session, ownerId: "foreign" } });
  expect(await prove(observation)).toBe(false);
  expect(isExecutionIdle).not.toHaveBeenCalled();
  getSession.mockResolvedValueOnce({ ok: true, session }).mockResolvedValueOnce({ ok: true,
    session: { ...session, backgroundRef: { id: "bg_00000000000000000000000000000002" } } });
  expect(await prove(observation)).toBe(false);
});

it("accepts only a confirmed stop of the retained background incarnation when idle control is unsupported", async () => {
  const backgroundRef = { id: "bg_00000000000000000000000000000001" };
  const session = { id: "sess_one", ownerId: "owner", kind: "agent", agent: "codex",
    runtime: { type: "background" }, backgroundRef };
  const observation = { ownerId: "owner", sessionId: session.id, backgroundRefId: backgroundRef.id,
    providerThreadId: "native_one", requestId: "req_latest" };
  const getSession = vi.fn().mockResolvedValue({ ok: true, session });
  const isRunning = vi.fn().mockResolvedValue(false);
  const prove = createCodexExecutionIdleProof({ sessions: () => ({ getSession }) as never,
    control: { isExecutionIdle: async () => false }, backgroundRuntime: { isRunning } });
  expect(await prove(observation)).toBe(true);
  expect(isRunning).toHaveBeenCalledWith(backgroundRef);
  isRunning.mockResolvedValueOnce(true);
  expect(await prove(observation)).toBe(false);
  isRunning.mockRejectedValueOnce(new Error("runtime state unavailable"));
  await expect(prove(observation)).rejects.toThrow("runtime state unavailable");
  isRunning.mockClear();
  getSession.mockResolvedValueOnce({ ok: true, session: { ...session, ownerId: "foreign" } });
  expect(await prove(observation)).toBe(false);
  expect(isRunning).not.toHaveBeenCalled();
  getSession.mockResolvedValueOnce({ ok: true, session }).mockResolvedValueOnce({ ok: true,
    session: { ...session, backgroundRef: { id: "bg_00000000000000000000000000000002" } } });
  expect(await prove(observation)).toBe(false);
});
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
