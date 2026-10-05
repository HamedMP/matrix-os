import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createGeminiCompanionAdapter, LIVE_COMPANION_TOOLS } from "../../../packages/gateway/src/live-companion/gemini-adapter.js";

describe("native Gemini adapter", () => {
  it("declares async tools for Gemini 3.8 Live", () => {
    expect(LIVE_COMPANION_TOOLS[0]?.functionDeclarations.every(tool => "behavior" in tool && tool.behavior === "NON_BLOCKING")).toBe(true);
  });
  it("mutes queued and future output on pause and explicitly ends the audio input stream", async () => {
    const provider = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), close: vi.fn(), sendAudio: vi.fn(), sendAudioStreamEnd: vi.fn(), restoreContext: vi.fn(), sendText: vi.fn(), sendToolResponse: vi.fn(), transcript: "" });
    const frames: any[] = [];
    const adapter = createGeminiCompanionAdapter({ connection: "test", model: "gemini-3.8-live", clientFactory: () => provider });
    const session = await adapter.start({ sessionId: "vs_pause", chatId: "chat_pause", principalId: "alice", turnMode: "hands_free", memoryMode: "ordinary", audio: { codec: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 }, emit: e => frames.push(e), live: { journal: vi.fn(async () => ({ messageId: "msg_source" })), delegate: vi.fn(), restore: vi.fn(async () => []), search: vi.fn(async () => []), status: vi.fn(async () => ({ state: "idle" })) } });
    session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    provider.emit("audio", { data: "AAAA" });
    session.setCapture(null);
    provider.emit("audio", { data: "AAAA" });
    provider.emit("output_transcript", { text: "Do not speak while paused." });
    provider.emit("turn_complete");
    provider.emit("audio", { data: "AAAA" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(frames.filter(e => e.type === "companion.frame" && e.frame.type === "response.audio")).toEqual([]);
    expect(provider.sendAudioStreamEnd).toHaveBeenCalledOnce();
    await session.close();
  });
  it("keeps captions flowing while a non-blocking delegation is awaiting admission", async () => {
    const provider = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), close: vi.fn(), sendAudio: vi.fn(), restoreContext: vi.fn(), sendText: vi.fn(), sendToolResponse: vi.fn(), transcript: "" });
    let resolve!: (value: any) => void;
    const admitted = new Promise<any>(r => { resolve = r; });
    const frames: any[] = [];
    const adapter = createGeminiCompanionAdapter({ connection: "test-key", model: "gemini-3.8-live", clientFactory: () => provider });
    const session = await adapter.start({ sessionId: "vs_async", chatId: "chat_async", principalId: "alice", turnMode: "hands_free", memoryMode: "ordinary", audio: { codec: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 }, emit: e => frames.push(e), live: { journal: vi.fn(async () => ({ messageId: "msg_source" })), delegate: () => admitted, restore: vi.fn(async () => []), search: vi.fn(async () => []), status: vi.fn(async () => ({ state: "idle" })) } });
    session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    provider.emit("input_transcript", { text: "Build a tracker" });
    provider.emit("tool_call", { id: "call_async", name: "delegate_task", args: { kind: "build_app", prompt: "ignored" } });
    provider.emit("output_transcript", { text: "We can keep talking." });
    try {
      await vi.waitFor(() => expect(frames.some(e => e.type === "companion.frame" && e.frame.text === "We can keep talking.")).toBe(true), { timeout: 300 });
    } finally { resolve({ outcome: "sent", runId: "run_real", revision: 1, canonicalTurnId: "cturn_real" }); await session.close(); }
    expect(provider.sendToolResponse).toHaveBeenCalledWith("call_async", expect.objectContaining({ scheduling: "WHEN_IDLE" }), "delegate_task");
  });
  it("uses native audio, Aoede, both live transcripts and bounded canonical delegation", async () => {
    const provider = Object.assign(new EventEmitter(), { connect: vi.fn(async () => {}), close: vi.fn(), restoreContext: vi.fn(), sendAudio: vi.fn(), sendText: vi.fn(), sendToolResponse: vi.fn(), transcript: "" });
    const factory = vi.fn(() => provider);
    const frames: any[] = [];
    const delegate = vi.fn(async () => ({ outcome: "sent" as const, canonicalTurnId: "cturn_real", runId: "run_real", revision: 1 }));
    const adapter = createGeminiCompanionAdapter({ connection: "test-key", model: "gemini-3.8-live", clientFactory: factory });
    const session = await adapter.start({ sessionId: "vs_live", chatId: "chat_live", principalId: "alice", turnMode: "hands_free", memoryMode: "ordinary", audio: { codec: "pcm_s16le", sampleRateHz: 16000, channels: 1, frameDurationMs: 20 }, emit: e => frames.push(e), live: { journal: vi.fn(async () => ({ messageId: "msg_source" })), delegate, restore: vi.fn(async () => []), search: vi.fn(async () => []), status: vi.fn(async () => ({ state: "running" })) } });
    expect(factory.mock.calls[0]?.[2]).toMatchObject({ voiceName: "Aoede", tools: expect.any(Array) });
    expect(provider.restoreContext).toHaveBeenCalledWith([]);
    expect(provider.sendText).not.toHaveBeenCalled();
    session.setCapture({ turnId: "vturn_one", mode: "hands_free" });
    session.pushAudio({ turnId: "vturn_one", timestampMs: 0, data: "AAAA" });
    provider.emit("input_transcript", { text: "Build a tracker" });
    provider.emit("tool_call", { id: "call_one", name: "delegate_task", args: { kind: "build_app", prompt: "Build a tracker" } });
    await vi.waitFor(() => expect(provider.sendToolResponse).toHaveBeenCalled());
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(provider.sendAudio).toHaveBeenCalledWith("AAAA");
    provider.emit("output_transcript", { text: "I've started it." });
    await vi.waitFor(() => expect(frames.some(e => e.type === "companion.frame" && e.frame.speaker === "assistant")).toBe(true));
    await session.close();
    expect(provider.close).toHaveBeenCalled();
  });
});
