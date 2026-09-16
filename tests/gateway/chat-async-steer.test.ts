import { ChatSteerNotDeliveredError } from "../../packages/gateway/src/chat/steer-delivery-error.js";
import { describe, expect, it, vi } from "vitest";
import { withAsyncChatInput } from "../../packages/gateway/src/chat/async-input-adapter.js";
import type { CanonicalChatProviderAdapter, CanonicalProviderRunEvent, CanonicalProviderRunInput } from "../../packages/gateway/src/chat/provider-adapter.js";

function fixture(active = false, closing = false, delayReceipt = false) {
  const controller = new AbortController();
  const input = { owner: { type: "personal", ownerId: "owner_1" }, chatId: "chat_1", runId: "run_1", turnId: "turn_1", prompt: "Ask a source", parts: [{ type: "text", text: "Ask a source" }], selection: { instanceId: "hermes", model: "test" }, interactionMode: "default", permissionMode: "full_access", signal: controller.signal } as CanonicalProviderRunInput;
  let live = false;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const question = { type: "input.requested" as const, requestId: "source", title: "Source", questions: [{ questionId: "source", header: "Source", question: "Which source?", allowOther: true, multiSelect: false, secret: false }] };
  const steer = vi.fn(async () => { if (!live) throw new ChatSteerNotDeliveredError(); });
  const resume = vi.fn(async function* (next: CanonicalProviderRunInput) {
    if (delayReceipt) await hold;
    if (controller.signal.aborted) return;
    yield { type: "assistant.delta", messageId: "reply", delta: next.prompt } as const;
    yield { type: "run.completed", outcome: "completed" } as const;
  });
  const native: CanonicalChatProviderAdapter = {
    driverKind: "hermes", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    async *start() {
      live = true;
      try {
        yield { type: "state.updated", state: { sessionId: "same_session" } };
        yield question;
        if (closing) live = false;
        if (active || closing) await hold;
        yield { type: "run.completed", outcome: "completed" };
      } finally { live = false; }
    },
    deferInput: async () => undefined, resume, steer,
  };
  const adapter = withAsyncChatInput(native);
  const events: CanonicalProviderRunEvent[] = [];
  const finished = (async () => { for await (const event of adapter.start(input)) events.push(event); })();
  const correction = { owner: input.owner, chatId: input.chatId, runId: input.runId, turnId: input.turnId, clientRequestId: "req_steer", prompt: "use linear instead", parts: [{ type: "text" as const, text: "use linear instead" }] };
  const idle = () => vi.waitFor(() => { expect(events.some(event => event.type === "input.requested")).toBe(true); expect(live).toBe(false); });
  const cleanup = async () => { controller.abort(); release(); await finished; };
  return { input, adapter, events, finished, correction, idle, cleanup, steer, resume, release };
}

describe("steering between asynchronous question phases", () => {
  it("resumes the same conversation and Run without answering outstanding questions", async () => {
    const f = fixture();
    try {
      await f.idle();
      await f.adapter.steer!(f.correction);
      await vi.waitFor(() => expect(f.resume).toHaveBeenCalledTimes(1));
      const next = f.resume.mock.calls[0]![0];
      expect(next).toMatchObject({ runId: f.input.runId, turnId: f.input.turnId, resumeState: { sessionId: "same_session" }, parts: f.correction.parts });
      expect(next.prompt).toContain("use linear instead");
      expect(next.continuationId).toMatch(/^run_async_/);
      expect(f.steer).not.toHaveBeenCalled();
      expect(f.events.some(event => event.type === "input.resolved" || event.type === "run.completed")).toBe(false);
      await f.adapter.submitInput!({ owner: f.input.owner, chatId: f.input.chatId, runId: f.input.runId, requestId: "source", clientRequestId: "req_answer", structuredAnswers: { source: ["Linear"] } });
      await f.finished;
      expect(f.resume).toHaveBeenCalledTimes(2);
      expect(f.events.filter(event => event.type === "input.resolved")).toHaveLength(1);
      expect(f.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    } finally { await f.cleanup(); }
  });

  it("forwards an active phase to native steering and never retries an uncertain rejection", async () => {
    const f = fixture(true);
    try {
      await vi.waitFor(() => expect(f.events.some(e => e.type === "input.requested")).toBe(true));
      await f.adapter.steer!(f.correction);
      expect(f.steer).toHaveBeenCalledTimes(1);
      f.steer.mockRejectedValueOnce(new Error("native delivery uncertain"));
      await expect(f.adapter.steer!(f.correction)).rejects.toThrow("native delivery uncertain");
      expect(f.resume).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("delivers simultaneous corrections and an answer once, in arrival order", async () => {
    const f = fixture();
    try {
      await f.idle();
      await Promise.all([
        f.adapter.steer!(f.correction),
        f.adapter.steer!({ ...f.correction, clientRequestId: "req_second", prompt: "keep it short" }),
        f.adapter.submitInput!({ owner: f.input.owner, chatId: f.input.chatId, runId: f.input.runId, requestId: "source", clientRequestId: "req_answer", structuredAnswers: { source: ["Linear"] } }),
      ]);
      await f.finished;
      expect(f.resume).toHaveBeenCalledTimes(3);
      const phases = f.resume.mock.calls.map(([next]) => next);
      expect(phases[0]!.prompt).toContain("use linear instead");
      expect(phases[1]!.prompt).toContain("keep it short");
      expect(phases[2]!.prompt).toContain("answers to your earlier asynchronous questions");
      expect(new Set(phases.map(next => next.continuationId)).size).toBe(3);
      expect(f.events.filter(e => e.type === "input.resolved")).toHaveLength(1);
      expect(f.events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    } finally { await f.cleanup(); }
  });

  it("does not let native steering overtake an answer queued during a live phase", async () => {
    const f = fixture(true);
    try {
      await vi.waitFor(() => expect(f.events.some(e => e.type === "input.requested")).toBe(true));
      await f.adapter.submitInput!({ owner: f.input.owner, chatId: f.input.chatId, runId: f.input.runId, requestId: "source", clientRequestId: "req_answer", structuredAnswers: { source: ["Linear"] } });
      const sent = f.adapter.steer!(f.correction);
      expect(f.steer).not.toHaveBeenCalled();
      f.release(); await sent; await f.finished;
      expect(f.resume.mock.calls.map(([next]) => next.prompt)).toEqual([
        expect.stringContaining("answers to your earlier asynchronous questions"),
        expect.stringContaining("use linear instead"),
      ]);
    } finally { await f.cleanup(); }
  });

  it("waits for native delivery before reporting a correction accepted", async () => {
    const f = fixture(false, false, true);
    try {
      await f.idle();
      let accepted = false;
      const sent = f.adapter.steer!(f.correction).then(() => { accepted = true; });
      await vi.waitFor(() => expect(f.resume).toHaveBeenCalledTimes(1));
      expect(accepted).toBe(false);
      f.release(); await sent;
      expect(accepted).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("rejects an unconfirmed correction on cancellation rather than reporting acceptance", async () => {
    const f = fixture(false, false, true);
    await f.idle();
    const sent = f.adapter.steer!(f.correction);
    const rejected = expect(sent).rejects.toThrow();
    await vi.waitFor(() => expect(f.resume).toHaveBeenCalledTimes(1));
    await f.cleanup(); await rejected;
  });

  it("recovers a definite non-delivery during native cleanup before its terminal event", async () => {
    const f = fixture(false, true);
    try {
      await f.idle();
      const sent = f.adapter.steer!(f.correction);
      // Let native.steer reject while the completed phase has not yielded its terminal event.
      await vi.waitFor(() => expect(f.steer).toHaveBeenCalledTimes(1));
      expect(f.resume).not.toHaveBeenCalled();
      f.release(); await sent;
      expect(f.resume).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it.each(["owner", "chat", "turn", "run"])("rejects a mismatched %s without delivering it", async (field) => {
    const f = fixture();
    try {
      await f.idle();
      const bad = { ...f.correction, ...(field === "owner" ? { owner: { type: "personal" as const, ownerId: "other" } } : { [`${field}Id`]: "other" }) };
      await expect(f.adapter.steer!(bad)).rejects.toThrow();
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.steer).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("rejects steering after cancellation", async () => {
    const f = fixture(); await f.idle(); await f.cleanup();
    await expect(f.adapter.steer!(f.correction)).rejects.toThrow();
    expect(f.resume).not.toHaveBeenCalled();
  });
});
