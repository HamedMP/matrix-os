import { describe, expect, it, vi } from "vitest";
import { createLiveCompanion } from "../../../packages/gateway/src/live-companion/coordinator.js";

function setup() {
  const frames: any[] = [];
  const journal = vi.fn(async (input: any) => ({ messageId: `msg_${input.id}` }));
  const delegate = vi.fn(async () => ({ outcome: "sent", runId: "run_real", revision: 2, canonicalTurnId: "cturn_real" }));
  const reply = vi.fn();
  const update = vi.fn();
  const port = { journal, delegate, search: vi.fn(async () => []), restore: vi.fn(async () => []), status: vi.fn(async () => ({ state: "running" })) };
  const live = createLiveCompanion({ port, emit: f => frames.push(f), reply, restoreContext: update, id: p => `${p}_${frames.length}`, chatId: "chat_real" });
  return { live, frames, journal, delegate, reply, update };
}

describe("native live companion", () => {
  it("retains unfinished speech across provider completion and journals only the completed correction", async () => {
    const s = setup();
    await s.live.input("vturn_one", "Build a tracker");
    await s.live.complete();
    expect(s.journal).not.toHaveBeenCalled();
    expect(s.frames.some(f => f.type === "companion.capture.completed")).toBe(false);
    await s.live.input("vturn_one", " actually make it a calendar", true);
    await s.live.tool("call_final", "delegate_task", { kind: "build_app", prompt: "ignored" });
    expect(s.journal).toHaveBeenCalledTimes(1);
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ text: "Build a tracker actually make it a calendar" }));
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.frames.filter(f => f.type === "companion.capture.completed")).toHaveLength(1);
    expect(s.frames.filter(f => f.type === "companion.caption" && f.speaker === "user" && f.final)).toHaveLength(1);
  });
  it("does not commit unfinished speech on close or utterance replacement", async () => {
    const s = setup();
    await s.live.input("vturn_one", "unfinished phrase");
    await s.live.input("vturn_two", "second unfinished phrase");
    await s.live.close();
    expect(s.journal).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent admission and bounds pending action categories without blocking captions", async () => {
    const s = setup(); let release!: (result: any) => void;
    const pending = new Promise<any>(r => { release = r; }); s.delegate.mockImplementation(() => pending);
    await s.live.input("vturn_one", "Do this work", true);
    const flights = [s.live.tool("call_one", "delegate_task", { kind: "task", prompt: "ignored" }), s.live.tool("call_duplicate", "delegate_task", { kind: "task", prompt: "ignored" }),
      s.live.tool("call_two", "delegate_task", { kind: "build_app", prompt: "ignored" }), s.live.tool("call_three", "delegate_task", { kind: "open_app", prompt: "ignored" })];
    await s.live.tool("call_four", "delegate_task", { kind: "terminal", prompt: "ignored" });
    expect(s.delegate).toHaveBeenCalledTimes(3);
    expect(s.reply).toHaveBeenCalledWith("call_four", expect.objectContaining({ status: "not_accepted" }), "delegate_task");
    await s.live.output("Still here");
    release({ outcome: "queued", canonicalQueuedTurnId: "qturn_real", revision: 1 }); await Promise.all(flights);
    expect(s.reply).toHaveBeenCalledWith("call_duplicate", expect.objectContaining({ queuedTurnId: "qturn_real" }), "delegate_task");
    await s.live.close();
  });
  it("finishes already-acknowledged audio when generation completes and rejects a finalized empty request", async () => {
    const s = setup(); await s.live.input("vturn_empty", "", true);
    await s.live.tool("call_empty", "delegate_task", { kind: "task", prompt: "ignored" });
    expect(s.delegate).not.toHaveBeenCalled();
    await s.live.output("Hello"); await s.live.audio("AAA=");
    const audio = s.frames.find(f => f.type === "response.audio");
    await s.live.played(audio.responseId, audio.segmentId); await s.live.complete();
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ text: "Hello", heard: true }));
  });
  it("rejects premature tool admission and retains the user's correction until explicit transcription completion", async () => {
    const s = setup();
    await s.live.input("vturn_one", "Build a tracker");
    await s.live.tool("call_early", "delegate_task", { kind: "build_app", prompt: "Build a tracker" });
    expect(s.delegate).not.toHaveBeenCalled();
    expect(s.journal).not.toHaveBeenCalled();
    await s.live.input("vturn_one", " actually make it a calendar", true);
    await s.live.tool("call_final", "delegate_task", { kind: "build_app", prompt: "Build a calendar" });
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ text: "Build a tracker actually make it a calendar" }));
    expect(s.delegate).toHaveBeenCalledOnce();
  });
  it("reads durable task state on replay instead of announcing a failed run as queued", async () => {
    const s = setup();
    s.delegate.mockResolvedValueOnce({ outcome: "sent", chatId: "chat_task", runId: "run_real", revision: 2, canonicalTurnId: "cturn_real", state: "running" } as any);
    s.delegate.mockResolvedValueOnce({ outcome: "already_accepted", chatId: "chat_task", runId: "run_real", revision: 3, canonicalTurnId: "cturn_real", state: "failed" } as any);
    await s.live.input("vturn_one", "Do a task", true);
    await s.live.tool("call_one", "delegate_task", { kind: "task", prompt: "ignored" });
    await s.live.tool("call_retry", "delegate_task", { kind: "task", prompt: "ignored" });
    expect(s.frames.filter(f => f.type === "companion.task").at(-1)).toMatchObject({ state: "failed" });
    expect(s.reply).toHaveBeenLastCalledWith("call_retry", expect.objectContaining({ state: "failed" }), "delegate_task");
  });
  it("journals casual speech without a second model run and streams both caption lanes", async () => {
    const s = setup();
    await s.live.input("vturn_one", "Hello there", true);
    await s.live.output("Hey.");
    await s.live.complete();
    expect(s.frames.filter(f => f.type === "companion.caption").map(f => f.speaker)).toContain("assistant");
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ role: "user", text: "Hello there" }));
    expect(s.delegate).not.toHaveBeenCalled();
  });
  it("returns a stable task handle through durable replay for the same utterance", async () => {
    const s = setup();
    await s.live.input("vturn_one", "Build a habit tracker", true);
    await s.live.tool("call_1", "delegate_task", { kind: "build_app", prompt: "Build a habit tracker" });
    await s.live.tool("call_2", "delegate_task", { kind: "build_app", prompt: "Build a habit tracker" });
    expect(s.delegate).toHaveBeenCalledTimes(2);
    expect(s.reply).toHaveBeenLastCalledWith("call_2", expect.objectContaining({ runId: "run_real" }), "delegate_task");
    expect(s.frames.filter(f => f.type === "companion.caption" && f.speaker === "user" && f.final)).toHaveLength(1);
  });
  it("does not grant commands from empty speech or accept arbitrary tool arguments", async () => {
    const s = setup();
    await s.live.tool("call_1", "delegate_task", { kind: "terminal", prompt: "rm -rf /" });
    await s.live.input("vturn_one", "Hello", true);
    await s.live.tool("call_2", "delegate_task", { kind: "terminal", prompt: "ls", permission: "bypass" });
    expect(s.delegate).not.toHaveBeenCalled();
  });
  it("permits later tasks after earlier work has finished; the durable broker enforces concurrency", async () => {
    const s = setup();
    for (let index = 0; index < 4; index++) {
      await s.live.input(`vturn_${index}`, "Do the next task", true);
      await s.live.tool(`call_${index}`, "delegate_task", { kind: "task", prompt: "ignored" });
      await s.live.complete();
    }
    expect(s.delegate).toHaveBeenCalledTimes(4);
  });
  it("marks interrupted output and never journals queued words as heard", async () => {
    const s = setup();
    await s.live.input("vturn_one", "Hello", true);
    await s.live.output("This was queued and unheard");
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    await s.live.interrupt();
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", heard: false }));
    expect(s.frames.at(-1)).toMatchObject({ type: "response.interrupted" });
  });
  it("preserves confirmed partial playback without guessing a word prefix from audio duration", async () => {
    const s = setup();
    await s.live.output("These generated words include an unplayed tail");
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    const first = s.frames.find(f => f.type === "response.audio");
    await s.live.played(first.responseId, first.segmentId);
    await s.live.interrupt();
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ text: "These generated words include an unplayed tail", heard: false }));
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ playedThroughMs: 10, heard: false }));
    expect(s.journal).not.toHaveBeenCalledWith(expect.objectContaining({ text: "These generated words include an unplayed tail", heard: true }));
  });
  it("retains the preceding user's words when a new utterance barges in before turn completion", async () => {
    const s = setup();
    await s.live.input("vturn_old", "Let's build a tracker", true);
    await s.live.output("Starting to answer");
    await s.live.interrupt();
    await s.live.input("vturn_new", "Actually, make it a calendar", true);
    await s.live.complete();
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ role: "user", text: "Let's build a tracker" }));
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ role: "user", text: "Actually, make it a calendar" }));
  });
  it("commits heard speech only after contiguous playback acknowledgements drain the response", async () => {
    const s = setup();
    await s.live.output("Heard words");
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    const audio = s.frames.filter(frame => frame.type === "response.audio");
    await s.live.complete();
    await s.live.played("vresp_wrong", audio[0].segmentId);
    await s.live.played(audio[1].responseId, audio[1].segmentId);
    expect(s.journal).not.toHaveBeenCalledWith(expect.objectContaining({ heard: true }));
    await s.live.played(audio[0].responseId, "vseg_missing");
    await s.live.played(audio[0].responseId, audio[0].segmentId);
    await s.live.played(audio[0].responseId, audio[0].segmentId);
    await s.live.played(audio[1].responseId, audio[1].segmentId);
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ text: "Heard words", heard: true }));
    expect(s.journal).toHaveBeenCalledTimes(1);
    await s.live.close();
    await s.live.played(audio[0].responseId, audio[0].segmentId);
    expect(s.journal).toHaveBeenCalledTimes(1);
  });
  it("marks a finished but unplayed response unheard before a new response starts", async () => {
    const s = setup();
    await s.live.output("Queued earlier response");
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    await s.live.complete();
    await s.live.output("New response");
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ text: "Queued earlier response", heard: false }));
    expect(s.frames.filter(frame => frame.type === "companion.response.started")).toHaveLength(2);
    await s.live.close();
  });
  it("projects retrieved sources, verifies task state, and never writes shared memory", async () => {
    const frames: any[] = [];
    const journal = vi.fn(); const delegate = vi.fn(); const reply = vi.fn();
    const source = { chatId: "chat_source", title: "Tracker", snippet: "Quoted data" };
    const live = createLiveCompanion({ port: { journal, delegate, search: async () => [source], restore: async () => [], status: async () => ({ state: "running" }) }, chatId: "chat_live", emit: frame => frames.push(frame), reply, restoreContext: vi.fn(), id: p => p });
    await live.tool("call_search", "find_chats", { query: "Tracker" });
    expect(frames.at(-1)).toMatchObject({ type: "companion.sources", sources: [source] });
    await live.tool("call_status", "check_task", {});
    expect(reply).toHaveBeenLastCalledWith("call_status", { state: "running" }, "check_task");
    await live.tool("call_remember", "remember", {});
    expect(reply).toHaveBeenLastCalledWith("call_remember", expect.objectContaining({ status: "unavailable" }), "remember");
    await live.tool("call_unknown", "exec", { command: "arbitrary" });
    expect(reply).toHaveBeenLastCalledWith("call_unknown", expect.objectContaining({ status: "not_accepted" }), "exec");
    expect(journal).not.toHaveBeenCalled(); expect(delegate).not.toHaveBeenCalled();
  });
  it("does not cancel authorized work when voice ends", async () => {
    const s = setup();
    await s.live.input("vturn_one", "Build a tracker", true);
    await s.live.tool("call_1", "delegate_task", { kind: "build_app", prompt: "Build a tracker" });
    await s.live.close();
    expect(s.delegate).toHaveBeenCalledTimes(1);
    expect(s.reply).toHaveBeenCalledWith("call_1", expect.objectContaining({ runId: "run_real" }), "delegate_task");
  });
  it("caps transcription and fails visibly instead of executing truncated speech", async () => {
    const s = setup();
    await s.live.input("vturn_one", "x".repeat(33000), true);
    await s.live.tool("call_1", "delegate_task", { kind: "build_app", prompt: "Build a tracker" });
    expect(s.delegate).not.toHaveBeenCalled();
    expect(s.frames.some(f => f.type === "session.error")).toBe(true);
  });
  it("applies the canonical 8000-character limit before journaling or executing", async () => {
    const s = setup();
    await s.live.input("vturn_one", "x".repeat(8001), true);
    await s.live.tool("call_one", "delegate_task", { kind: "task", prompt: "ignored" });
    await s.live.close();
    expect(s.journal).not.toHaveBeenCalled();
    expect(s.delegate).not.toHaveBeenCalled();
  });
  it("does not commit partially dropped audio as heard", async () => {
    const s = setup();
    await s.live.output("Partial response");
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    await s.live.audio("invalid");
    await s.live.complete();
    const audio = s.frames.find(f => f.type === "response.audio");
    await s.live.played(audio.responseId, audio.segmentId);
    expect(s.journal).not.toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", heard: true }));
  });
  it("bounds output text and audio backlog without falsely committing unheard speech", async () => {
    for (const overflow of ["text", "audio", "segments"] as const) {
      const s = setup(); await s.live.output("Valid prefix");
      if (overflow === "text") await s.live.output("x".repeat(8001));
      if (overflow === "audio") for (let n = 0; n < 6; n++) await s.live.audio(Buffer.alloc(48000).toString("base64"));
      if (overflow === "segments") for (let n = 0; n < 513; n++) await s.live.audio("AAA=");
      expect(s.frames.some(frame => frame.type === "session.error")).toBe(true);
      await s.live.complete(); await s.live.close();
      expect(s.journal).not.toHaveBeenCalledWith(expect.objectContaining({ heard: true }));
    }
  });
  it("rejects late speech changes to an admitted source, then accepts a new utterance", async () => {
    const s = setup();
    await s.live.input("vturn_one", "Do a task", true);
    await s.live.tool("call_one", "delegate_task", { kind: "task", prompt: "ignored" });
    await s.live.input("vturn_one", " and also delete everything");
    await s.live.tool("call_late", "delegate_task", { kind: "terminal", prompt: "ignored" });
    expect(s.delegate).toHaveBeenCalledTimes(1);
    await s.live.input("vturn_two", "Do a different task", true);
    await s.live.tool("call_two", "delegate_task", { kind: "task", prompt: "ignored" });
    expect(s.delegate).toHaveBeenCalledTimes(2);
  });
  it("does not revive a closed voice session or execute malformed provider call identities", async () => {
    const s = setup();
    await s.live.restore(); expect(s.update).toHaveBeenCalledWith([]);
    await s.live.input("vturn_one", "Do a task", true);
    await s.live.tool("invalid call id", "delegate_task", { kind: "task", prompt: "ignored" });
    expect(s.delegate).not.toHaveBeenCalled();
    await s.live.close(); await s.live.close();
    const count = s.frames.length;
    await s.live.input("vturn_two", "Do another task", true);
    await s.live.output("Late response"); await s.live.audio("AAAA");
    await s.live.complete(); await s.live.interrupt();
    await s.live.tool("call_two", "delegate_task", { kind: "task", prompt: "ignored" });
    expect(s.frames).toHaveLength(count); expect(s.delegate).not.toHaveBeenCalled();
  });
});
