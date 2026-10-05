import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createGeminiCompanionAdapter } from "../../../packages/gateway/src/live-companion/gemini-adapter.js";
import type { LiveCompanionPort } from "../../../packages/gateway/src/live-companion/coordinator.js";
import type { VoiceCanonicalChatEvent } from "../../../packages/gateway/src/voice-session/ports.js";

function rig(overrides: Partial<LiveCompanionPort> = {}) {
  const provider = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), close: vi.fn(), sendAudio: vi.fn(), sendAudioStreamEnd: vi.fn(), restoreContext: vi.fn(), sendText: vi.fn(), sendToolResponse: vi.fn(), transcript: "" });
  const frames: any[] = [];
  const port: LiveCompanionPort = { journal: vi.fn(async () => ({ messageId: "msg_source" })), delegate: vi.fn(), restore: async () => [], search: async () => [], status: async () => ({ state: "idle" }), ...overrides };
  const context = { sessionId: "vs_lifecycle", chatId: "chat_live", principalId: "alice", turnMode: "hands_free" as const, memoryMode: "ordinary" as const,
    audio: { codec: "pcm_s16le" as const, sampleRateHz: 16000 as const, channels: 1 as const, frameDurationMs: 20 }, emit: (event: any) => frames.push(event), live: port };
  const adapter = createGeminiCompanionAdapter({ connection: "fixture", model: "gemini-3.8-live", clientFactory: () => provider });
  return { provider, frames, port, adapter, context, start: () => adapter.start(context) };
}

describe("native Gemini lifecycle boundaries", () => {
  it("ignores uncaptured transcripts, fences queued output on pause, and drains live task subscriptions on close", async () => {
    const dispose = vi.fn();
    const s = rig({ resumeTasks: async () => [{ chatId: "chat_task", runId: "run_task", state: "running", label: "Task" }], watchTask: () => dispose });
    const session = await s.start();
    s.provider.emit("input_transcript", { text: "No microphone active", finished: true });
    session.pushAudio({ turnId: "vturn_wrong", timestampMs: 0, data: "AAA=" });
    session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    s.provider.emit("output_transcript", { text: "Queued before pause" });
    session.setCapture(null);
    session.native!.onTask({ type: "run.state", runId: "run_root", state: "running" });
    await session.close();
    expect(s.port.journal).not.toHaveBeenCalled(); expect(s.provider.sendAudio).not.toHaveBeenCalled();
    expect(s.frames.some(frame => frame.frame?.text === "Queued before pause")).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    const count = s.frames.length;
    session.native!.onTask({ type: "run.terminal", runId: "run_root", state: "succeeded" });
    s.provider.emit("turn_complete"); s.provider.emit("disconnected");
    s.provider.emit("error", { message: "Late provider error after close" });
    expect(s.frames).toHaveLength(count);
  });
  it("rejects missing canonical authority or incompatible audio before connecting", async () => {
    const s = rig();
    await expect(s.adapter.start({ ...s.context, live: undefined })).rejects.toThrow();
    await expect(s.adapter.start({ ...s.context, audio: { ...s.context.audio, sampleRateHz: 24000 } })).rejects.toThrow();
    expect(s.provider.connect).not.toHaveBeenCalled();
  });
  it("splits native audio at sample boundaries and commits only acknowledged playback", async () => {
    const s = rig(); const session = await s.start();
    session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    s.provider.emit("input_transcript", { text: "Hello" });
    s.provider.emit("output_transcript", { text: "Good morning" });
    s.provider.emit("audio", { data: Buffer.alloc(96_000).toString("base64") });
    s.provider.emit("turn_complete");
    await vi.waitFor(() => expect(s.frames.filter(e => e.type === "companion.frame" && e.frame.type === "response.audio")).toHaveLength(2));
    const segments = s.frames.filter(e => e.frame?.type === "response.audio").map(e => e.frame);
    expect(segments.map(f => Buffer.from(f.data, "base64").length)).toEqual([48_000, 48_000]);
    session.native!.played(segments[0].responseId, segments[0].segmentId);
    session.native!.played(segments[1].responseId, segments[1].segmentId);
    await vi.waitFor(() => expect(s.port.journal).toHaveBeenCalledWith(expect.objectContaining({ role: "assistant", heard: true })));
    session.synthesize({} as never); session.cancelResponse("vresp_unused");
    expect(s.provider.sendText).not.toHaveBeenCalled();
    await session.close(); await session.close();
    expect(s.provider.close).toHaveBeenCalledOnce();
  });
  it("bounds simultaneous tools while keeping native media responsive", async () => {
    let release!: (value: never[]) => void;
    const pending = new Promise<never[]>(r => { release = r; });
    const s = rig({ search: () => pending }); const session = await s.start();
    for (let index = 0; index < 4; index++) s.provider.emit("tool_call", { id: `call_${index}`, name: "find_chats", args: { query: "Tracker" } });
    s.provider.emit("output_transcript", { text: "We can keep talking" });
    try {
      await vi.waitFor(() => expect(s.provider.sendToolResponse).toHaveBeenCalledWith("call_3", expect.objectContaining({ status: "not_accepted", scheduling: "WHEN_IDLE" }), "find_chats"));
      expect(s.frames.some(frame => frame.frame?.text === "We can keep talking")).toBe(true);
    } finally { release([]); await session.close(); }
  });
  it("fails visibly when an incoming media burst exceeds the bounded queue", async () => {
    const s = rig(); const session = await s.start();
    for (let index = 0; index < 130; index++) s.provider.emit("output_transcript", { text: "x" });
    await vi.waitFor(() => expect(s.frames).toContainEqual(expect.objectContaining({ type: "error", code: "audio_backpressure", fatal: true })));
    await session.close();
  });
  it("reports provider failures with safe codes and cleans up failed startup", async () => {
    const s = rig(); const session = await s.start();
    s.provider.emit("error", { message: "/private/provider/secret" });
    s.provider.emit("disconnected");
    expect(s.frames).toContainEqual({ type: "error", code: "provider_unavailable", retryable: true, fatal: true });
    expect(s.frames).toContainEqual({ type: "error", code: "connection_lost", retryable: true, fatal: true });
    expect(JSON.stringify(s.frames)).not.toContain("secret");
    await session.close();
    const failed = rig(); failed.provider.connect.mockRejectedValueOnce(new Error("Startup unavailable"));
    await expect(failed.start()).rejects.toThrow("Startup unavailable");
    expect(failed.provider.close).toHaveBeenCalledOnce();
  });
  it("fails safely on canonical journal errors and provider text overflow", async () => {
    const failed = rig({ journal: async () => { throw new Error("private database connection detail"); } });
    const session = await failed.start(); session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    failed.provider.emit("input_transcript", { text: "Hello" }); failed.provider.emit("turn_complete");
    await vi.waitFor(() => expect(failed.frames).toContainEqual({ type: "error", code: "chat_unavailable", retryable: true, fatal: true }));
    expect(JSON.stringify(failed.frames)).not.toContain("database connection detail");
    // The engine's close path sees the journal failure; it must not be mistaken for a successful write.
    await expect(session.close()).rejects.toThrow();
    const oversized = rig(); const other = await oversized.start();
    oversized.provider.emit("output_transcript", { text: "x".repeat(8001) });
    await vi.waitFor(() => expect(oversized.frames).toContainEqual({ type: "error", code: "session_limit_reached", retryable: false, fatal: true }));
    await other.close();
  });
  it("handles native interruption without replaying old queued audio and permits fresh speech", async () => {
    const s = rig(); const session = await s.start(); session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    s.provider.emit("audio", { data: "AAA=" }); s.provider.emit("interrupted");
    s.provider.emit("input_transcript", { text: "New request" });
    s.provider.emit("output_transcript", { text: "New answer" });
    s.provider.emit("audio", { data: "AAA=" });
    await vi.waitFor(() => expect(s.frames.filter(event => event.frame?.type === "response.audio")).toHaveLength(1));
    session.interrupt("vresp_current", 0);
    s.provider.emit("audio", { data: "AAA=" });
    s.provider.emit("input_transcript", { text: "Another request" });
    s.provider.emit("audio", { data: "AAA=" });
    await vi.waitFor(() => expect(s.frames.filter(event => event.frame?.type === "response.audio")).toHaveLength(2));
    await session.close();
  });
  it("reattaches running tasks, coalesces updates while speaking, and unsubscribes on terminal state", async () => {
    const dispose = vi.fn(); let update!: (event: VoiceCanonicalChatEvent) => void;
    const s = rig({ resumeTasks: async () => [{ chatId: "chat_task", runId: "run_task", state: "running", label: "Build tracker" }],
      watchTask: (_id, listener) => { update = listener; return dispose; } });
    const session = await s.start();
    session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    s.provider.emit("input_transcript", { text: "Let's talk" });
    update({ type: "assistant.text", runId: "run_task", text: "Do not synthesize another agent", textStart: 0, textEnd: 30 });
    update({ type: "run.started", runId: "run_task" });
    update({ type: "run.terminal", runId: "run_task", state: "succeeded" });
    expect(s.provider.sendText).not.toHaveBeenCalled();
    s.provider.emit("turn_complete");
    await vi.waitFor(() => expect(s.provider.sendText).toHaveBeenCalledOnce());
    expect(s.provider.sendText.mock.calls[0]?.[0]).toContain('"state":"succeeded"');
    expect(dispose).toHaveBeenCalledOnce();
    await session.close();
  });
});
