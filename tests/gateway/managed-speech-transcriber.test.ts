import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PlatformSpeechClient } from "../../packages/gateway/src/speech/platform-client.js";
import {
  createFfmpegPcmWavConverter,
  createManagedChannelSttProvider,
  createManagedOwnerAudioTranscriber,
} from "../../packages/gateway/src/speech/managed-transcriber.js";
import { inspectSpeechWav } from "../../packages/platform/src/speech/media.js";

function wav(durationMs = 100): Uint8Array {
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * durationMs / 1_000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

function client(outcome: "transcript" | "no_speech" = "transcript"): PlatformSpeechClient {
  return {
    ownerId: "user_alice",
    capabilities: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    transcribe: vi.fn(async (input) => outcome === "transcript" ? {
      contractVersion: "1" as const,
      requestId: input.requestId,
      status: "succeeded" as const,
      outcome,
      text: "managed transcript",
      audioDurationMs: 100,
    } : {
      contractVersion: "1" as const,
      requestId: input.requestId,
      status: "succeeded" as const,
      outcome,
      audioDurationMs: 100,
    }),
  };
}

describe("managed speech transcribers", () => {
  it("converts owner audio and submits it through the owner-audio platform policy", async () => {
    const platform = client();
    const converted = wav();
    const converter = vi.fn(async () => converted);
    const transcriber = createManagedOwnerAudioTranscriber({ client: platform, converter });
    const source = new Uint8Array([1, 2, 3]);
    const signal = new AbortController().signal;

    await expect(transcriber.transcribe({ audio: source, fileName: "voice.ogg", signal }))
      .resolves.toEqual({ text: "managed transcript", durationMs: 100 });
    expect(converter).toHaveBeenCalledWith(source, "voice.ogg", signal);
    expect(platform.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.stringMatching(/^sp_[0-9]{13}_[a-f0-9]{32}$/),
      sourceKind: "owner_audio",
      audio: converted,
      mediaType: "audio/wav",
      signal,
    }));
  });

  it("exposes the same managed path to channels without treating no-speech as an error", async () => {
    const platform = client("no_speech");
    const converter = vi.fn(async () => wav());
    const provider = createManagedChannelSttProvider({ client: platform, converter });

    expect(provider.isAvailable()).toBe(true);
    await expect(provider.transcribe(Buffer.from("ogg"))).resolves.toEqual({
      text: "",
      language: "",
      durationMs: 100,
    });
    expect(platform.transcribe).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: "owner_audio" }));
  });

  it.runIf(existsSync("/usr/bin/ffmpeg"))("produces a platform-compatible bounded PCM WAV locally", async () => {
    const converter = createFfmpegPcmWavConverter({ ffmpegPath: "/usr/bin/ffmpeg" });
    const converted = await converter(wav(), "source.wav", AbortSignal.timeout(10_000));
    expect(inspectSpeechWav(converted, { maxBytes: 10 * 1024 * 1024, maxDurationMs: 2_000 }))
      .toMatchObject({ mediaType: "audio/wav", sampleRate: 16_000, channels: 1 });
  });
});
