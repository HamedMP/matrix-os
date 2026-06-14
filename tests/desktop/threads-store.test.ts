import { beforeEach, describe, expect, it } from "vitest";
import { useThreads, type AgentThread } from "@desktop/renderer/src/stores/threads";

function reset(): void {
  useThreads.setState({ threads: [], activeThreadId: null });
}

function getThread(id: string): AgentThread {
  const thread = useThreads.getState().threads.find((t) => t.id === id);
  if (!thread) throw new Error(`thread ${id} not found`);
  return thread;
}

beforeEach(reset);

describe("startThread", () => {
  it("creates a running thread with an optimistic user message", () => {
    const t = useThreads.getState().startThread({ text: "Fix the bug", requestId: "r1", now: 1000 });
    expect(t.status).toBe("running");
    expect(t.requestId).toBe("r1");
    expect(t.sessionId).toBeNull();
    expect(t.taskId).toBeNull();
    expect(t.unread).toBe(false);
    expect(t.createdAt).toBe(1000);
    expect(t.updatedAt).toBe(1000);
    expect(t.title).toBe("Fix the bug");
    expect(t.transcript).toHaveLength(1);
    expect(t.transcript[0]).toMatchObject({
      role: "user",
      content: "Fix the bug",
      requestId: "r1",
      timestamp: 1000,
    });
  });

  it("orders threads newest first and honors explicit title/taskId/sessionId", () => {
    const a = useThreads.getState().startThread({ text: "first", requestId: "r1", now: 1 });
    const b = useThreads.getState().startThread({
      text: "second",
      title: "Custom title",
      taskId: "task-9",
      sessionId: "s-1",
      requestId: "r2",
      now: 2,
    });
    const { threads } = useThreads.getState();
    expect(threads.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(b.title).toBe("Custom title");
    expect(b.taskId).toBe("task-9");
    expect(b.sessionId).toBe("s-1");
  });

  it("caps threads at 100 dropping the oldest finished threads first", () => {
    const store = useThreads.getState();
    const first = store.startThread({ text: "oldest finished", requestId: "r0", now: 0 });
    for (let i = 1; i < 100; i++) {
      store.startThread({ text: `t${i}`, requestId: `r${i}`, now: i });
    }
    useThreads.getState().handleKernelMessage({ type: "kernel:result", data: {}, requestId: "r0" });
    useThreads.getState().startThread({ text: "newest", requestId: "r100", now: 100 });
    const { threads } = useThreads.getState();
    expect(threads).toHaveLength(100);
    expect(threads.some((t) => t.id === first.id)).toBe(false);
    expect(threads[0]!.requestId).toBe("r100");
    expect(threads.some((t) => t.requestId === "r1")).toBe(true);
  });

  it("enforces the cap of 100 even when every thread is running", () => {
    const store = useThreads.getState();
    for (let i = 0; i <= 100; i++) {
      store.startThread({ text: `t${i}`, requestId: `r${i}`, now: i });
    }
    const { threads } = useThreads.getState();
    expect(threads).toHaveLength(100);
    expect(threads.some((t) => t.requestId === "r0")).toBe(false);
  });
});

describe("handleKernelMessage routing", () => {
  it("routes events to the matching thread by requestId without cross-talk", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "one", requestId: "r1", now: 1 });
    const t2 = store.startThread({ text: "two", requestId: "r2", now: 2 });
    const handle = useThreads.getState().handleKernelMessage;
    handle({ type: "kernel:text", text: "A", requestId: "r1" });
    handle({ type: "kernel:text", text: "B", requestId: "r2" });
    handle({ type: "kernel:text", text: "A2", requestId: "r1" });
    const got1 = getThread(t1.id);
    const got2 = getThread(t2.id);
    expect(got1.transcript).toHaveLength(2);
    expect(got1.transcript[1]).toMatchObject({ role: "assistant", content: "AA2" });
    expect(got2.transcript).toHaveLength(2);
    expect(got2.transcript[1]).toMatchObject({ role: "assistant", content: "B" });
  });

  it("ignores kernel events with no matching requestId", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    const result = useThreads
      .getState()
      .handleKernelMessage({ type: "kernel:text", text: "stray", requestId: "r-none" });
    expect(result).toEqual({});
    expect(getThread(t.id).transcript).toHaveLength(1);
  });

  it("ignores chat events without a requestId and unknown message types", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    expect(useThreads.getState().handleKernelMessage({ type: "kernel:text", text: "no-id" })).toEqual({});
    expect(
      useThreads.getState().handleKernelMessage({ type: "file:change", path: "/x", event: "add" }),
    ).toEqual({});
    expect(useThreads.getState().handleKernelMessage({ type: "pong" })).toEqual({});
    expect(getThread(t.id).transcript).toHaveLength(1);
  });

  it("binds sessionId from kernel:init by requestId", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    useThreads.getState().handleKernelMessage({ type: "kernel:init", sessionId: "s-9", requestId: "r1" });
    expect(getThread(t.id).sessionId).toBe("s-9");
  });

  it("binds sessionId from session:switched to the active thread", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "one", requestId: "r1", now: 1 });
    store.startThread({ text: "two", requestId: "r2", now: 2 });
    useThreads.getState().setActiveThread(t1.id);
    useThreads.getState().handleKernelMessage({ type: "session:switched", sessionId: "s-2" });
    expect(getThread(t1.id).sessionId).toBe("s-2");
  });
});

describe("status transitions", () => {
  it("kernel:result marks the thread done", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    useThreads.getState().setActiveThread(t.id);
    useThreads.getState().handleKernelMessage({ type: "kernel:result", data: {}, requestId: "r1" });
    expect(getThread(t.id).status).toBe("done");
  });

  it("kernel:error marks the thread failed and appends an error bubble", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    useThreads.getState().setActiveThread(t.id);
    useThreads.getState().handleKernelMessage({ type: "kernel:error", message: "Run failed", requestId: "r1" });
    const got = getThread(t.id);
    expect(got.status).toBe("failed");
    expect(got.transcript[got.transcript.length - 1]).toMatchObject({
      role: "system",
      content: "Run failed",
    });
  });

  it("kernel:aborted marks the thread aborted and stops in-flight tools", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    useThreads.getState().setActiveThread(t.id);
    useThreads.getState().handleKernelMessage({ type: "kernel:tool_start", tool: "Bash", requestId: "r1" });
    useThreads.getState().handleKernelMessage({ type: "kernel:aborted", requestId: "r1" });
    const got = getThread(t.id);
    expect(got.status).toBe("aborted");
    expect(got.transcript.some((m) => m.content === "Stopped Bash")).toBe(true);
    expect(got.transcript[got.transcript.length - 1]!.content).toBe("Stopped.");
  });

  it("approval:request marks the most recent running thread needs-attention", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "one", requestId: "r1", now: 1 });
    const t2 = store.startThread({ text: "two", requestId: "r2", now: 2 });
    useThreads.getState().handleKernelMessage({ type: "kernel:result", data: {}, requestId: "r2" });
    useThreads.getState().handleKernelMessage({
      type: "approval:request",
      id: "ap-1",
      toolName: "Bash",
      args: {},
      timeout: 30,
    });
    expect(getThread(t1.id).status).toBe("needs-attention");
    expect(getThread(t2.id).status).toBe("done");
  });
});

describe("unread and notifications", () => {
  it("returns a done notification and marks unread for an unfocused thread", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "background", requestId: "r1", now: 1 });
    const t2 = store.startThread({ text: "focused", requestId: "r2", now: 2 });
    useThreads.getState().setActiveThread(t2.id);
    const result = useThreads
      .getState()
      .handleKernelMessage({ type: "kernel:result", data: {}, requestId: "r1" });
    expect(result.notification).toMatchObject({ threadId: t1.id, kind: "done", title: t1.title });
    expect(typeof result.notification!.body).toBe("string");
    expect(getThread(t1.id).unread).toBe(true);
  });

  it("returns no notification for a focused thread", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    useThreads.getState().setActiveThread(t.id);
    const result = useThreads
      .getState()
      .handleKernelMessage({ type: "kernel:result", data: {}, requestId: "r1" });
    expect(result.notification).toBeUndefined();
    expect(getThread(t.id).unread).toBe(false);
  });

  it("honors the focusedThreadId option over activeThreadId", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "one", requestId: "r1", now: 1 });
    useThreads.getState().setActiveThread(t1.id);
    const result = useThreads
      .getState()
      .handleKernelMessage(
        { type: "kernel:result", data: {}, requestId: "r1" },
        { focusedThreadId: "someone-else" },
      );
    expect(result.notification).toMatchObject({ threadId: t1.id, kind: "done" });
    expect(getThread(t1.id).unread).toBe(true);
  });

  it("marks unread on text deltas to unfocused threads without a notification", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "one", requestId: "r1", now: 1 });
    const t2 = store.startThread({ text: "two", requestId: "r2", now: 2 });
    useThreads.getState().setActiveThread(t2.id);
    const result = useThreads
      .getState()
      .handleKernelMessage({ type: "kernel:text", text: "hi", requestId: "r1" });
    expect(result.notification).toBeUndefined();
    expect(getThread(t1.id).unread).toBe(true);
  });

  it("returns failed and attention notifications for unfocused transitions", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "one", requestId: "r1", now: 1 });
    const t2 = store.startThread({ text: "two", requestId: "r2", now: 2 });
    useThreads.getState().setActiveThread(null);
    const failed = useThreads
      .getState()
      .handleKernelMessage({ type: "kernel:error", message: "boom", requestId: "r2" });
    expect(failed.notification).toMatchObject({ threadId: t2.id, kind: "failed" });
    const attention = useThreads.getState().handleKernelMessage({
      type: "approval:request",
      id: "ap-1",
      toolName: "Bash",
      args: {},
      timeout: 30,
    });
    expect(attention.notification).toMatchObject({ threadId: t1.id, kind: "attention" });
  });

  it("returns no notification for aborts", () => {
    useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    useThreads.getState().setActiveThread(null);
    const result = useThreads.getState().handleKernelMessage({ type: "kernel:aborted", requestId: "r1" });
    expect(result.notification).toBeUndefined();
  });

  it("setActiveThread clears unread and unreadCount tallies", () => {
    const store = useThreads.getState();
    const t1 = store.startThread({ text: "one", requestId: "r1", now: 1 });
    const t2 = store.startThread({ text: "two", requestId: "r2", now: 2 });
    useThreads.getState().setActiveThread(t2.id);
    useThreads.getState().handleKernelMessage({ type: "kernel:text", text: "hi", requestId: "r1" });
    expect(useThreads.getState().unreadCount()).toBe(1);
    useThreads.getState().setActiveThread(t1.id);
    expect(getThread(t1.id).unread).toBe(false);
    expect(useThreads.getState().unreadCount()).toBe(0);
  });
});

describe("abortThread", () => {
  it("returns the requestId without changing status until kernel:aborted arrives", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    const result = useThreads.getState().abortThread(t.id);
    expect(result).toEqual({ requestId: "r1" });
    expect(getThread(t.id).status).toBe("running");
    useThreads.getState().handleKernelMessage({ type: "kernel:aborted", requestId: "r1" });
    expect(getThread(t.id).status).toBe("aborted");
  });

  it("returns null for unknown ids and finished threads", () => {
    const t = useThreads.getState().startThread({ text: "x", requestId: "r1", now: 1 });
    useThreads.getState().handleKernelMessage({ type: "kernel:result", data: {}, requestId: "r1" });
    expect(useThreads.getState().abortThread(t.id)).toBeNull();
    expect(useThreads.getState().abortThread("missing")).toBeNull();
  });
});

describe("transcript cap", () => {
  it("caps the transcript at 500 messages keeping the newest", () => {
    const t = useThreads.getState().startThread({ text: "start", requestId: "r1", now: 1 });
    for (let i = 0; i < 600; i++) {
      useThreads.getState().handleKernelMessage({
        type: "kernel:tool_start",
        tool: `Tool${i}`,
        requestId: "r1",
      });
    }
    const got = getThread(t.id);
    expect(got.transcript).toHaveLength(500);
    expect(got.transcript[0]!.content).not.toBe("start");
    expect(got.transcript[got.transcript.length - 1]!.content).toBe("Using Tool599...");
    expect(got.transcript[0]!.content).toBe("Using Tool100...");
  });
});
