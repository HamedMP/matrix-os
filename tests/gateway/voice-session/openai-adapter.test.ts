/**
 * Chunked voice media adapter tests over the direct OpenAI speech ports.
 *
 * `createOpenAiVoiceMediaAdapter` is the provider-neutral path driven by an
 * injected `VoiceSpeechPorts` pair: buffered capture -> WAV -> port
 * transcription -> `transcript.final`, and canonical segment text -> port
 * synthesis stream -> `synthesis.audio`/`synthesis.end`. The direct-OpenAI
 * ports are exercised through a stubbed `fetchImpl` and the VAD hangover
 * runs on a fake clock — no real provider/network calls are made.
 */
import { describe, expect, it } from "vitest";
import type { VoiceResponseSegment } from "@matrix-os/contracts/voice-session";
import {
  VoiceAdapterCapabilitiesSchema,
  VoiceMediaAdapterRegistry,
  type VoiceAdapterEvent,
  type VoiceAdapterSessionContext,
  type VoiceMediaAdapter,
  type VoiceMediaSession,
} from "../../../packages/gateway/src/voice-session/adapter.js";
import { createDirectOpenAiSpeechPorts } from "../../../packages/gateway/src/voice-session/direct-openai-ports.js";
import {
  createOpenAiVoiceMediaAdapter,
  type OpenAiVoiceAdapterOptions,
} from "../../../packages/gateway/src/voice-session/openai-adapter.js";
import { FakeClock } from "./fakes.js";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const API_KEY = "sk-test-0123456789abcdef";

interface FetchCall {
  input: string;
  init: RequestInit;
}

type FetchHandler = (call: FetchCall) => Promise<Response> | Response;

interface Harness {
  adapter: VoiceMediaAdapter;
  session: VoiceMediaSession;
  events: VoiceAdapterEvent[];
  calls: FetchCall[];
  clock: FakeClock;
}

async function startSession(options: {
  handler?: FetchHandler;
  adapter?: Partial<OpenAiVoiceAdapterOptions>;
  context?: Partial<VoiceAdapterSessionContext>;
} = {}): Promise<Harness> {
  const clock = new FakeClock();
  const events: VoiceAdapterEvent[] = [];
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { input: String(input), init: init ?? {} };
    calls.push(call);
    if (!options.handler) throw new Error(`unexpected fetch ${call.input}`);
    return options.handler(call);
  }) as typeof fetch;
  const adapter = createOpenAiVoiceMediaAdapter({
    speech: createDirectOpenAiSpeechPorts({
      apiKey: API_KEY,
      transcriptionModel: "gpt-4o-mini-transcribe",
      speechModel: "gpt-4o-mini-tts",
      voice: "alloy",
      fetchImpl,
    }),
    clock,
    ...options.adapter,
  });
  const context: VoiceAdapterSessionContext = {
    sessionId: "vs_test",
    chatId: "chat_test",
    principalId: "user_test",
    turnMode: "hands_free",
    memoryMode: "ordinary",
    audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
    emit: (event) => {
      events.push(event);
    },
    ...options.context,
  };
  const session = await adapter.start(context);
  return { adapter, session, events, calls, clock };
}

function pcmS16Frame(amplitude: number, ms = 20, sampleRateHz = 16_000): string {
  const samples = Math.round((sampleRateHz * ms) / 1_000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(amplitude, i * 2);
  return buf.toString("base64");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pcmStreamResponse(chunks: readonly Uint8Array[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status },
  );
}

function pcmBytes(length: number, fill = 0x11): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function segment(segmentId: string, segmentIndex = 0): VoiceResponseSegment {
  return { segmentId, segmentIndex, textStart: 0, textEnd: 6, durationMs: 0 };
}

/** Flush pending microtasks/stream reads a bounded number of times. */
async function flushAsync(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

function eventsOfType<T extends VoiceAdapterEvent["type"]>(
  events: VoiceAdapterEvent[],
  type: T,
): Extract<VoiceAdapterEvent, { type: T }>[] {
  return events.filter((event): event is Extract<VoiceAdapterEvent, { type: T }> => event.type === type);
}

describe("createOpenAiVoiceMediaAdapter", () => {
  it("registers in the adapter registry with schema-valid capabilities", () => {
    const adapter = createOpenAiVoiceMediaAdapter({
      speech: createDirectOpenAiSpeechPorts({
        apiKey: API_KEY,
        transcriptionModel: "gpt-4o-mini-transcribe",
        speechModel: "gpt-4o-mini-tts",
        voice: "alloy",
      }),
    });
    expect(adapter.id).toBe("openai");
    expect(() => VoiceAdapterCapabilitiesSchema.parse(adapter.capabilities)).not.toThrow();
    expect(adapter.capabilities).toMatchObject({
      transportModes: ["relayed_websocket"],
      turnModes: ["hands_free", "push_to_talk"],
      supportsInterruption: true,
      resume: "rebuild_only",
      // No canonical memory suppression exists yet — the adapter must not
      // claim an enforceable session-only route.
      sessionOnly: "unsupported",
      actionMode: "conversation_only",
      actionCancellation: "run",
      supportsInputSelection: true,
      supportsOutputSelection: true,
      // Output format is declared separately from the 16kHz capture format.
      outputAudio: { codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
    });
    const registry = new VoiceMediaAdapterRegistry();
    expect(() => registry.register(adapter)).not.toThrow();
    expect(registry.get("openai")).toBe(adapter);
    expect(registry.default()).toBe(adapter);
  });

  it("requires a complete speech port pair — a hear-but-mute adapter is a construction error", () => {
    const speech = createDirectOpenAiSpeechPorts({
      apiKey: API_KEY,
      transcriptionModel: "gpt-4o-mini-transcribe",
      speechModel: "gpt-4o-mini-tts",
      voice: "alloy",
    });
    // @ts-expect-error — synthesize is required, not optional
    expect(() => createOpenAiVoiceMediaAdapter({ speech: { transcribe: speech.transcribe } }))
      .toThrow(TypeError);
    // @ts-expect-error — speech must be an object with both ports
    expect(() => createOpenAiVoiceMediaAdapter({ speech: undefined }))
      .toThrow(TypeError);
  });

  it("transcribes a push_to_talk turn and emits transcript.final with a stable finalityId", async () => {
    const h = await startSession({
      handler: () => jsonResponse({ text: "  hello there  " }),
      context: { turnMode: "push_to_talk" },
    });
    h.session.setCapture({ turnId: "vturn_1", mode: "push_to_talk" });
    h.session.pushAudio({ turnId: "vturn_1", timestampMs: 0, data: pcmS16Frame(8_000) });
    h.session.pushAudio({ turnId: "vturn_1", timestampMs: 20, data: pcmS16Frame(8_000) });
    h.session.setCapture(null);
    await flushAsync();

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.input).toBe(TRANSCRIPTIONS_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    const form = call.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file).toBeTruthy();
    expect(file.type).toBe("audio/wav");
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // s16le
    expect(wav.readUInt32LE(40)).toBe(2 * 640); // two 20ms frames
    expect(wav.length).toBe(44 + 2 * 640);

    expect(h.events).toEqual([
      { type: "transcript.final", turnId: "vturn_1", finalityId: "trn_vturn_1", text: "hello there" },
    ]);
  });

  it("emits no transcript event for an empty transcription", async () => {
    const h = await startSession({ handler: () => jsonResponse({ text: "   " }) });
    h.session.setCapture({ turnId: "vturn_1", mode: "push_to_talk" });
    h.session.pushAudio({ turnId: "vturn_1", timestampMs: 0, data: pcmS16Frame(8_000) });
    h.session.setCapture(null);
    await flushAsync();
    expect(h.calls).toHaveLength(1);
    expect(eventsOfType(h.events, "transcript.final")).toHaveLength(0);
    expect(h.events).toHaveLength(0);
  });

  it("auto-finalizes a hands_free turn on the silence hangover after min speech", async () => {
    const h = await startSession({ handler: () => jsonResponse({ text: "hands free" }) });
    h.session.setCapture({ turnId: "vturn_2", mode: "hands_free" });
    // 400ms of speech (above the 500 RMS threshold, past the 250ms minimum).
    for (let i = 0; i < 20; i += 1) {
      h.session.pushAudio({ turnId: "vturn_2", timestampMs: i * 20, data: pcmS16Frame(8_000) });
    }
    expect(h.events).toContainEqual({ type: "vad", turnId: "vturn_2", action: "speech_start" });
    // Trailing silence arms the hangover; it has not fired yet.
    for (let i = 20; i < 25; i += 1) {
      h.session.pushAudio({ turnId: "vturn_2", timestampMs: i * 20, data: pcmS16Frame(0) });
    }
    expect(eventsOfType(h.events, "vad").map((event) => event.action)).toEqual(["speech_start"]);
    expect(h.calls).toHaveLength(0);

    h.clock.advance(900);
    expect(eventsOfType(h.events, "vad").map((event) => event.action)).toEqual([
      "speech_start",
      "speech_end",
    ]);
    await flushAsync();
    expect(h.calls).toHaveLength(1);
    expect(eventsOfType(h.events, "transcript.final")).toEqual([
      { type: "transcript.final", turnId: "vturn_2", finalityId: "trn_vturn_2", text: "hands free" },
    ]);
  });

  it("maps transcription HTTP failures to provider_unavailable and timeouts to connection_failed", async () => {
    const failing = await startSession({
      handler: () => new Response("provider exploded", { status: 500 }),
    });
    failing.session.setCapture({ turnId: "vturn_1", mode: "push_to_talk" });
    failing.session.pushAudio({ turnId: "vturn_1", timestampMs: 0, data: pcmS16Frame(8_000) });
    failing.session.setCapture(null);
    await flushAsync();
    expect(failing.events).toEqual([
      { type: "error", code: "provider_unavailable", retryable: true, fatal: false },
    ]);
    // No provider names, endpoints, or raw error text may leak upstream.
    expect(JSON.stringify(failing.events)).not.toMatch(/openai|exploded|api\.openai/i);

    const timingOut = await startSession({
      handler: () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
    });
    timingOut.session.setCapture({ turnId: "vturn_1", mode: "push_to_talk" });
    timingOut.session.pushAudio({ turnId: "vturn_1", timestampMs: 0, data: pcmS16Frame(8_000) });
    timingOut.session.setCapture(null);
    await flushAsync();
    expect(timingOut.events).toEqual([
      { type: "error", code: "connection_failed", retryable: true, fatal: false },
    ]);
  });

  it("streams speech synthesis chunks with monotonic offsets and a matching total", async () => {
    const h = await startSession({
      handler: () => pcmStreamResponse([pcmBytes(24_576), pcmBytes(4_800)]),
    });
    h.session.synthesize({ responseId: "vresp_1", segment: segment("vseg_1"), text: "Hello." });
    await flushAsync();

    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.input).toBe(SPEECH_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Hello.",
      response_format: "pcm",
    });

    const audio = eventsOfType(h.events, "synthesis.audio");
    expect(audio).toHaveLength(2);
    expect(audio[0]).toMatchObject({ responseId: "vresp_1", segmentId: "vseg_1", startMs: 0, durationMs: 512 });
    expect(audio[1]).toMatchObject({ responseId: "vresp_1", segmentId: "vseg_1", startMs: 512, durationMs: 100 });
    expect(Buffer.from(audio[0]!.data, "base64")).toHaveLength(24_576);
    expect(Buffer.from(audio[1]!.data, "base64")).toHaveLength(4_800);
    // Every frame is stamped with the real 24kHz output format — never the
    // negotiated 16kHz capture format.
    for (const frame of audio) {
      expect(frame.format).toEqual({ codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 });
    }
    const ends = eventsOfType(h.events, "synthesis.end");
    // Per-command end: scoped to the drained segment, cumulative duration.
    expect(ends).toEqual([
      { type: "synthesis.end", responseId: "vresp_1", generatedDurationMs: 612, segmentId: "vseg_1" },
    ]);
  });

  it("maps synthesis HTTP failures to provider_unavailable without provider detail", async () => {
    const h = await startSession({
      handler: () => new Response("provider exploded", { status: 503 }),
    });
    h.session.synthesize({ responseId: "vresp_1", segment: segment("vseg_1"), text: "Hello." });
    await flushAsync();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.input).toBe(SPEECH_URL);
    expect(h.events).toEqual([
      { type: "error", code: "provider_unavailable", retryable: true, fatal: false },
    ]);
    expect(JSON.stringify(h.events)).not.toMatch(/openai|exploded|api\.openai/i);
  });

  it("serializes queued segments for one response in order", async () => {
    let release: ((response: Response) => void) | undefined;
    let speechCalls = 0;
    const h = await startSession({
      handler: () => {
        speechCalls += 1;
        if (speechCalls === 1) {
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return pcmStreamResponse([pcmBytes(4_800)]);
      },
    });
    h.session.synthesize({ responseId: "vresp_1", segment: segment("vseg_1", 0), text: "one" });
    h.session.synthesize({ responseId: "vresp_1", segment: segment("vseg_2", 1), text: "two" });
    await flushAsync();
    // The second segment is queued behind the in-flight first call.
    expect(h.calls).toHaveLength(1);
    release!(pcmStreamResponse([pcmBytes(4_800)]));
    await flushAsync();
    expect(h.calls).toHaveLength(2);
    const audio = eventsOfType(h.events, "synthesis.audio");
    expect(audio.map((event) => [event.segmentId, event.startMs])).toEqual([
      ["vseg_1", 0],
      ["vseg_2", 100],
    ]);
    const ends = eventsOfType(h.events, "synthesis.end");
    // Each queued segment drains with its own scoped end; the cumulative
    // generatedDurationMs keeps climbing across the response.
    expect(ends.map((event) => [event.segmentId, event.generatedDurationMs])).toEqual([
      ["vseg_1", 100],
      ["vseg_2", 200],
    ]);
  });

  it("cancelResponse and interrupt abort in-flight synthesis without further events", async () => {
    const h = await startSession({
      handler: (call) =>
        new Promise<Response>((_resolve, reject) => {
          (call.init.signal as AbortSignal).addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    h.session.synthesize({ responseId: "vresp_1", segment: segment("vseg_1"), text: "one" });
    h.session.synthesize({ responseId: "vresp_2", segment: segment("vseg_9"), text: "two" });
    await flushAsync();
    expect(h.calls).toHaveLength(2);

    h.session.cancelResponse("vresp_1");
    h.session.interrupt("vresp_2", 0);
    await flushAsync();
    expect(eventsOfType(h.events, "synthesis.audio")).toHaveLength(0);
    expect(eventsOfType(h.events, "synthesis.end")).toHaveLength(0);
    expect(eventsOfType(h.events, "error")).toHaveLength(0);
    expect(h.events).toHaveLength(0);

    // A muted response ignores later synthesis commands entirely.
    h.session.synthesize({ responseId: "vresp_1", segment: segment("vseg_2", 1), text: "again" });
    await flushAsync();
    expect(h.calls).toHaveLength(2);
    expect(h.events).toHaveLength(0);
  });

  it("emits audio_backpressure once when the capture buffer overflows", async () => {
    const h = await startSession({
      handler: () => jsonResponse({ text: "never reached" }),
      adapter: { maxCaptureBytes: 256 },
    });
    h.session.setCapture({ turnId: "vturn_1", mode: "push_to_talk" });
    const frame = pcmS16Frame(8_000); // 640 bytes decoded
    h.session.pushAudio({ turnId: "vturn_1", timestampMs: 0, data: frame });
    h.session.pushAudio({ turnId: "vturn_1", timestampMs: 20, data: frame });
    h.session.pushAudio({ turnId: "vturn_1", timestampMs: 40, data: frame });
    expect(eventsOfType(h.events, "error")).toEqual([
      { type: "error", code: "audio_backpressure", retryable: false, fatal: false },
    ]);
    h.session.setCapture(null);
    await flushAsync();
    // Everything past the cap is dropped — nothing reached the provider.
    expect(eventsOfType(h.events, "error")).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
  });

  it("close() is idempotent and silences all pending work", async () => {
    const h = await startSession({
      handler: (call) =>
        new Promise<Response>((_resolve, reject) => {
          (call.init.signal as AbortSignal).addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    h.session.setCapture({ turnId: "vturn_1", mode: "push_to_talk" });
    h.session.pushAudio({ turnId: "vturn_1", timestampMs: 0, data: pcmS16Frame(8_000) });
    h.session.setCapture(null);
    h.session.synthesize({ responseId: "vresp_1", segment: segment("vseg_1"), text: "one" });
    await flushAsync();
    expect(h.calls).toHaveLength(2);

    h.session.close();
    h.session.close();
    await flushAsync();
    expect(h.events).toHaveLength(0);

    // Commands after close are inert.
    h.session.setCapture({ turnId: "vturn_2", mode: "push_to_talk" });
    h.session.pushAudio({ turnId: "vturn_2", timestampMs: 0, data: pcmS16Frame(8_000) });
    h.session.setCapture(null);
    h.session.synthesize({ responseId: "vresp_2", segment: segment("vseg_3"), text: "late" });
    await flushAsync();
    expect(h.calls).toHaveLength(2);
    expect(h.events).toHaveLength(0);
  });
});
