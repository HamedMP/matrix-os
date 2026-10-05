import { describe, expect, it, vi } from "vitest";
import { createLiveCompanion } from "../../../packages/gateway/src/live-companion/coordinator.js";

function setup() {
  const frames: any[] = [];
  const journal = vi.fn(async (input: any) => ({ messageId: `msg_${input.id}` }));
  const delegate = vi.fn(async () => ({ outcome: "sent", runId: "run_real", revision: 2, canonicalTurnId: "cturn_real" }));
  const reply = vi.fn();
  const update = vi.fn();
  const port = { journal, delegate, search: vi.fn(async () => []), restore: vi.fn(async () => []), status: vi.fn(async () => ({ state: "running" })) };
  const live = createLiveCompanion({ port, emit: f => frames.push(f), reply, update, id: p => `${p}_${frames.length}`, chatId: "chat_real" });
  return { live, frames, journal, delegate, reply, update };
}

describe("native live companion", () => {
  it("journals casual speech without a second model run and streams both caption lanes", async () => {
    const s = setup();
    s.live.input("vturn_one", "Hello there");
    await s.live.output("Hey.");
    await s.live.complete();
    expect(s.frames.filter(f => f.type === "companion.caption").map(f => f.speaker)).toContain("assistant");
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ role: "user", text: "Hello there" }));
    expect(s.delegate).not.toHaveBeenCalled();
  });
  it("returns a real task handle and deduplicates repeated tool calls for the same utterance", async () => {
    const s = setup();
    s.live.input("vturn_one", "Build a habit tracker");
    await s.live.tool("call_1", "delegate_task", { kind: "build_app", prompt: "Build a habit tracker" });
    await s.live.tool("call_2", "delegate_task", { kind: "build_app", prompt: "Build a habit tracker" });
    expect(s.delegate).toHaveBeenCalledTimes(1);
    expect(s.reply).toHaveBeenLastCalledWith("call_2", expect.objectContaining({ runId: "run_real" }), "delegate_task");
  });
  it("does not grant commands from empty speech or accept arbitrary tool arguments", async () => {
    const s = setup();
    await s.live.tool("call_1", "delegate_task", { kind: "terminal", prompt: "rm -rf /" });
    s.live.input("vturn_one", "Hello");
    await s.live.tool("call_2", "delegate_task", { kind: "terminal", prompt: "ls", permission: "bypass" });
    expect(s.delegate).not.toHaveBeenCalled();
  });
  it("permits later tasks after earlier work has finished; the durable broker enforces concurrency", async () => {
    const s = setup();
    for (let index = 0; index < 4; index++) {
      s.live.input(`vturn_${index}`, "Do the next task");
      await s.live.tool(`call_${index}`, "delegate_task", { kind: "task", prompt: "ignored" });
      await s.live.complete();
    }
    expect(s.delegate).toHaveBeenCalledTimes(4);
  });
  it("marks interrupted output and never journals queued words as heard", async () => {
    const s = setup();
    s.live.input("vturn_one", "Hello");
    await s.live.output("This was queued and unheard");
    await s.live.audio(Buffer.alloc(480).toString("base64"));
    await s.live.interrupt();
    expect(s.journal).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", heard: false }));
    expect(s.frames.at(-1)).toMatchObject({ type: "response.interrupted" });
  });
  it("does not cancel authorized work when voice ends", async () => {
    const s = setup();
    s.live.input("vturn_one", "Build a tracker");
    await s.live.tool("call_1", "delegate_task", { kind: "build_app", prompt: "Build a tracker" });
    await s.live.close();
    expect(s.delegate).toHaveBeenCalledTimes(1);
    expect(s.reply).toHaveBeenCalledWith("call_1", expect.objectContaining({ runId: "run_real" }), "delegate_task");
  });
  it("caps transcription and fails visibly instead of executing truncated speech", async () => {
    const s = setup();
    s.live.input("vturn_one", "x".repeat(33000));
    await s.live.tool("call_1", "delegate_task", { kind: "build_app", prompt: "Build a tracker" });
    expect(s.delegate).not.toHaveBeenCalled();
    expect(s.frames.some(f => f.type === "session.error")).toBe(true);
  });
  it("applies the canonical 8000-character limit before journaling or executing", async () => {
    const s = setup();
    s.live.input("vturn_one", "x".repeat(8001));
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
});
