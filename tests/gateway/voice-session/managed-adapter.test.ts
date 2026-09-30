/**
 * Managed (Platform Speech) voice adapter path.
 *
 * `createManagedVoiceTranscriptionPort` wraps the provisioned platform
 * client as a `VoiceTranscriptionPort`: conforming `sp_` request ids,
 * `sourceKind: "dictation"`, WAV media, bounded hints, and only classified
 * `VoiceSpeechPortError` kinds leaving the boundary. The client here is a
 * stub — a real `PlatformSpeechClient` is never constructed in tests.
 */
import { describe, expect, it } from "vitest";
import { SpeechRequestIdSchema } from "@matrix-os/contracts";
import type { VoiceResponseSegment } from "@matrix-os/contracts/voice-session";
import type {
  VoiceAdapterEvent,
  VoiceAdapterSessionContext,
} from "../../../packages/gateway/src/voice-session/adapter.js";
import { createOpenAiVoiceMediaAdapter } from "../../../packages/gateway/src/voice-session/openai-adapter.js";
import { VoiceSpeechPortError } from "../../../packages/gateway/src/voice-session/speech-ports.js";
import {
  PlatformSpeechClientError,
  type PlatformSpeechClient,
} from "../../../packages/gateway/src/speech/platform-client.js";
import { createManagedVoiceTranscriptionPort } from "../../../packages/gateway/src/speech/voice-session-ports.js";
import { FakeClock } from "./fakes.js";

type TranscribeInput = Parameters<PlatformSpeechClient["transcribe"]>[0];
type TranscribeResult = Awaited<ReturnType<PlatformSpeechClient["transcribe"]>>;
type ClientCode = ConstructorParameters<typeof PlatformSpeechClientError>[0];

interface FakeClient {
  calls: TranscribeInput[];
  transcribe: PlatformSpeechClient["transcribe"];
}

function makeFakeClient(
  respond: (input: TranscribeInput) => unknown,
): FakeClient {
  const calls: TranscribeInput[] = [];
  return {
    calls,
    transcribe: async (input) => {
      calls.push(input);
      return respond(input) as TranscribeResult;
    },
  };
}

function transcriptResult(requestId: string, text: string) {
  return {
    contractVersion: 1 as const,
    requestId,
    status: "succeeded" as const,
    outcome: "transcript" as const,
    text,
    audioDurationMs: 320,
  };
}

function wavBody(ms = 40): Buffer {
  const pcm = Buffer.alloc(16_000 * 2 * (ms / 1_000), 7);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe("createManagedVoiceTranscriptionPort", () => {
  it("issues a conforming dictation transcription over the platform client", async () => {
    const client = makeFakeClient((input) => transcriptResult(input.requestId, "  managed hello  "));
    const port = createManagedVoiceTranscriptionPort({ client });
    const controller = new AbortController();
    const wav = wavBody();
    const result = await port({
      wav,
      languageHints: ["en-US", "!!bad hint!!", "fr"],
      signal: controller.signal,
    });
    expect(result).toEqual({ text: "managed hello" });
    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(() => SpeechRequestIdSchema.parse(call.requestId)).not.toThrow();
    expect(call.sourceKind).toBe("dictation");
    expect(call.mediaType).toBe("audio/wav");
    expect(call.signal).toBe(controller.signal);
    expect(Buffer.from(call.audio)).toEqual(wav);
    // Only the sanitized hints are forwarded; malformed entries are dropped.
    expect(call.languageHints).toEqual(["en-US", "fr"]);
  });

  it("maps no_speech to an empty transcript (no event upstream)", async () => {
    const client = makeFakeClient((input) => ({
      contractVersion: 1 as const,
      requestId: input.requestId,
      status: "succeeded" as const,
      outcome: "no_speech" as const,
      audioDurationMs: 320,
    }));
    const port = createManagedVoiceTranscriptionPort({ client });
    const result = await port({ wav: wavBody(), signal: new AbortController().signal });
    expect(result).toEqual({ text: "" });
  });

  it("bounds overlong transcripts to the wire transcript limit", async () => {
    const client = makeFakeClient((input) => transcriptResult(input.requestId, "x".repeat(9_999)));
    const port = createManagedVoiceTranscriptionPort({ client });
    const result = await port({ wav: wavBody(), signal: new AbortController().signal });
    expect(result.text.length).toBe(8_000);
  });

  it("collapses platform failures to classified kinds — no codes or messages leak", async () => {
    const cases: [ClientCode, string][] = [
      ["unavailable", "unavailable"],
      ["rate_limited", "unavailable"],
      ["allowance_exhausted", "unavailable"],
      ["timeout", "timeout"],
      ["invalid_response", "unavailable"],
    ];
    for (const [code, kind] of cases) {
      const client = makeFakeClient(() => {
        throw new PlatformSpeechClientError(code, "Speech is unavailable", 503);
      });
      const port = createManagedVoiceTranscriptionPort({ client });
      const failure = await port({ wav: wavBody(), signal: new AbortController().signal })
        .then(() => "resolved" as const)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(VoiceSpeechPortError);
      expect((failure as VoiceSpeechPortError).kind).toBe(kind);
      expect(JSON.stringify(failure)).not.toMatch(/platform|openai|Speech is unavailable/i);
    }
  });

  it("treats aborts and unknown throws as aborted/connection without provider detail", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const client = makeFakeClient(() => {
      throw new Error("socket hangup internals");
    });
    const port = createManagedVoiceTranscriptionPort({ client });
    const abortFailure = await port({ wav: wavBody(), signal: aborted.signal })
      .catch((error: unknown) => error);
    expect((abortFailure as VoiceSpeechPortError).kind).toBe("aborted");

    const connFailure = await port({ wav: wavBody(), signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect((connFailure as VoiceSpeechPortError).kind).toBe("connection");
    expect(JSON.stringify(connFailure)).not.toMatch(/socket|hangup/i);
  });
});

describe("managed adapter end-to-end (managed STT + injected synthesizer)", () => {
  function pcmS16Frame(amplitude: number, ms = 20): string {
    const samples = Math.round((16_000 * ms) / 1_000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) buf.writeInt16LE(amplitude, i * 2);
    return buf.toString("base64");
  }

  function segment(segmentId: string, segmentIndex = 0): VoiceResponseSegment {
    return { segmentId, segmentIndex, textStart: 0, textEnd: 6, durationMs: 0 };
  }

  async function flushAsync(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  it("runs a session whose STT is managed and whose speech carries the declared output format", async () => {
    const client = makeFakeClient((input) => transcriptResult(input.requestId, "hello managed"));
    const events: VoiceAdapterEvent[] = [];
    const adapter = createOpenAiVoiceMediaAdapter({
      id: "managed",
      speech: {
        transcribe: createManagedVoiceTranscriptionPort({ client }),
        synthesize: async function* () {
          yield Buffer.alloc(4_800, 2);
        },
        outputAudio: { codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
      },
      clock: new FakeClock(),
    });
    const context: VoiceAdapterSessionContext = {
      sessionId: "vs_managed",
      chatId: "chat_test",
      principalId: "user_test",
      turnMode: "push_to_talk",
      memoryMode: "ordinary",
      locale: "en-US",
      audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
      emit: (event) => events.push(event),
    };
    const session = await adapter.start(context);
    session.setCapture({ turnId: "vturn_9", mode: "push_to_talk" });
    session.pushAudio({ turnId: "vturn_9", timestampMs: 0, data: pcmS16Frame(8_000) });
    session.setCapture(null);
    session.synthesize({ responseId: "vresp_1", segment: segment("vseg_1"), text: "hello" });
    await flushAsync();

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.sourceKind).toBe("dictation");
    expect(client.calls[0]!.languageHints).toEqual(["en-US"]);
    expect(events).toContainEqual({
      type: "transcript.final",
      turnId: "vturn_9",
      finalityId: "trn_vturn_9",
      text: "hello managed",
    });
    expect(events).toContainEqual({
      type: "synthesis.end",
      responseId: "vresp_1",
      generatedDurationMs: 100,
      segmentId: "vseg_1",
    });
    const audio = events.filter((event) => event.type === "synthesis.audio");
    expect(audio[0]).toMatchObject({
      format: { codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
    });
  });
});
