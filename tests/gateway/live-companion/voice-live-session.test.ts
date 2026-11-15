import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceLiveSession } from "../../../packages/gateway/src/live-companion/voice-live-session.js";
import type { VoiceAdapterSessionContext, VoiceMediaAdapter, VoiceMediaSession } from "../../../packages/gateway/src/voice-session/adapter.js";

function fakeAdapter() {
  const media = {
    setCapture: vi.fn(), pushAudio: vi.fn(), interrupt: vi.fn(),
    close: vi.fn(async () => undefined),
    native: { played: vi.fn(), onTask: vi.fn() },
  } satisfies VoiceMediaSession;
  let context: VoiceAdapterSessionContext | undefined;
  const adapter = { id: "fake", capabilities: {} as VoiceMediaAdapter["capabilities"],
    start: vi.fn(async (ctx: VoiceAdapterSessionContext) => { context = ctx; return media; }) } satisfies VoiceMediaAdapter;
  return { adapter, media, context: () => context! };
}

const port = { journal: vi.fn(), delegate: vi.fn(), search: vi.fn(), restore: vi.fn(), status: vi.fn() };
const audio = Buffer.alloc(320).toString("base64");

describe("voice live session", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function open(limits = { maxSessionMs: 60_000, idleMs: 10_000 }) {
    const fake = fakeAdapter();
    const sent: Array<Record<string, unknown>> = [];
    const onClosed = vi.fn();
    const session = await createVoiceLiveSession({ adapter: fake.adapter, port, chatId: "chat_voice", principalId: "alice",
      send: frame => sent.push(frame), onClosed, limits });
    return { ...fake, sent, session, onClosed };
  }

  it("starts the adapter on the owner's Chat with 16 kHz input and announces readiness", async () => {
    const { adapter, context, sent } = await open();
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(context()).toMatchObject({ chatId: "chat_voice", principalId: "alice", live: port,
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1 } });
    expect(sent[0]).toEqual({ type: "session.ready", chatId: "chat_voice" });
  });

  it("binds audio to a server-issued capture turn and releases it on stop", async () => {
    const { media, session } = await open();
    await session.handle(JSON.stringify({ type: "capture.start" }));
    const turnId = media.setCapture.mock.calls[0]![0]!.turnId;
    expect(turnId).toMatch(/^vturn_[A-Za-z0-9_-]+$/);
    await session.handle(JSON.stringify({ type: "audio", data: audio }));
    expect(media.pushAudio).toHaveBeenCalledWith(expect.objectContaining({ turnId, data: audio }));
    await session.handle(JSON.stringify({ type: "capture.stop" }));
    expect(media.setCapture).toHaveBeenLastCalledWith(null);
    await session.handle(JSON.stringify({ type: "audio", data: audio }));
    expect(media.pushAudio).toHaveBeenCalledTimes(1);
  });

  it("forwards companion frames and turns fatal adapter errors into a generic error and close", async () => {
    const { context, sent, media, onClosed } = await open();
    context().emit({ type: "companion.frame", frame: { type: "companion.caption", speaker: "user", turnId: "vturn_a", text: "hi", final: true, interrupted: false } });
    expect(sent.at(-1)).toMatchObject({ type: "companion.caption", text: "hi" });
    context().emit({ type: "error", code: "provider_unavailable", retryable: true, fatal: true });
    await vi.runAllTimersAsync();
    expect(sent.at(-1)).toEqual({ type: "error", code: "provider_unavailable", retryable: true });
    expect(media.close).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
  });

  it("routes playback acknowledgements and barge-in to the adapter", async () => {
    const { media, session } = await open();
    await session.handle(JSON.stringify({ type: "played", responseId: "vresp_a", segmentId: "vseg_a" }));
    expect(media.native.played).toHaveBeenCalledWith("vresp_a", "vseg_a");
    await session.handle(JSON.stringify({ type: "interrupt", responseId: "vresp_a", playedThroughMs: 120 }));
    expect(media.interrupt).toHaveBeenCalledWith("vresp_a", 120);
  });

  it("rejects malformed, unknown and oversized frames without reaching the adapter", async () => {
    const { media, session, sent, onClosed } = await open();
    await session.handle("{not json");
    expect(sent.at(-1)).toEqual({ type: "error", code: "invalid_request", retryable: false });
    expect(onClosed).toHaveBeenCalledOnce();
    expect(media.pushAudio).not.toHaveBeenCalled();
    const second = await open();
    await second.session.handle(JSON.stringify({ type: "audio", data: "x".repeat(300_000) }));
    expect(second.sent.at(-1)).toEqual({ type: "error", code: "invalid_request", retryable: false });
    const third = await open();
    await third.session.handle(JSON.stringify({ type: "shell.exec", command: "rm" }));
    expect(third.sent.at(-1)).toEqual({ type: "error", code: "invalid_request", retryable: false });
  });

  it("ends idle sessions and sessions past their maximum length", async () => {
    const idle = await open({ maxSessionMs: 60_000, idleMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(idle.sent.at(-1)).toEqual({ type: "session.ended", reason: "idle" });
    expect(idle.media.close).toHaveBeenCalledOnce();

    const long = await open({ maxSessionMs: 20_000, idleMs: 10_000 });
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(5_000); await long.session.handle(JSON.stringify({ type: "heartbeat" })); }
    expect(long.sent.at(-1)).toEqual({ type: "session.ended", reason: "max_duration" });
  });

  it("closes once, even when the owner ends and the socket closes", async () => {
    const { media, session, onClosed, sent } = await open();
    await session.handle(JSON.stringify({ type: "end" }));
    await session.close("socket_closed");
    expect(media.close).toHaveBeenCalledOnce();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(sent.at(-1)).toEqual({ type: "session.ended", reason: "user" });
  });

  it("closes the adapter and reports a generic error when start fails", async () => {
    const fake = fakeAdapter();
    fake.adapter.start.mockRejectedValueOnce(new Error("upstream said: secret detail"));
    const sent: Array<Record<string, unknown>> = [];
    await expect(createVoiceLiveSession({ adapter: fake.adapter, port, chatId: "chat_voice", principalId: "alice",
      send: frame => sent.push(frame), onClosed: vi.fn(), limits: { maxSessionMs: 1000, idleMs: 1000 } })).rejects.toThrow();
    expect(JSON.stringify(sent)).not.toContain("secret");
  });
});
