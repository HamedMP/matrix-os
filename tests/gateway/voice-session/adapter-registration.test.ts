/**
 * Voice adapter registration policy matrix.
 *
 * `registerVoiceSessionMediaAdapters` is the single authority deciding which
 * media adapter (if any) a gateway registers. The matrix pins the security
 * invariants: outside production the simulator flag always wins while
 * production denies it outright, a managed adapter only exists when a
 * synthesis port exists too, and a direct provider key is a
 * development-only escape hatch that production ignores entirely. All
 * provider seams are injected fakes — no env leaks, no fetches.
 */
import { describe, expect, it } from "vitest";
import type { VoiceAdapterSessionContext, VoiceAdapterEvent } from "../../../packages/gateway/src/voice-session/adapter.js";
import {
  createAdapterCapabilityPort,
  VoiceMediaAdapterRegistry,
} from "../../../packages/gateway/src/voice-session/adapter.js";
import {
  registerVoiceSessionMediaAdapters,
  type VoiceAdapterRegistrationOutcome,
} from "../../../packages/gateway/src/voice-session/adapter-registration.js";
import type { DirectOpenAiSpeechPortOptions } from "../../../packages/gateway/src/voice-session/direct-openai-ports.js";
import type {
  VoiceSpeechPorts,
  VoiceTranscriptionPort,
} from "../../../packages/gateway/src/voice-session/speech-ports.js";
import { FakeClock } from "./fakes.js";

const DIRECT_ENV = {
  MATRIX_VOICE_DIRECT_OPENAI: "1",
  MATRIX_VOICE_OPENAI_API_KEY: "  sk-dev-key  ",
};

interface Rig {
  registry: VoiceMediaAdapterRegistry;
  outcome: VoiceAdapterRegistrationOutcome;
  logs: { event: string; fields: Record<string, unknown> }[];
  directCalls: DirectOpenAiSpeechPortOptions[];
  managedCalls: { wav: Buffer; signal: AbortSignal }[];
  directPorts: VoiceSpeechPorts;
}

function run(env: NodeJS.ProcessEnv, options: { managed?: boolean; managedSynthesis?: boolean } = {}): Rig {
  const registry = new VoiceMediaAdapterRegistry();
  const logs: Rig["logs"] = [];
  const directCalls: DirectOpenAiSpeechPortOptions[] = [];
  const managedCalls: Rig["managedCalls"] = [];
  const managedTranscribe: VoiceTranscriptionPort = async (request) => {
    managedCalls.push({ wav: request.wav, signal: request.signal });
    return { text: "managed transcript" };
  };
  const directPorts: VoiceSpeechPorts = {
    transcribe: async () => ({ text: "direct transcript" }),
    synthesize: async function* () {
      yield Buffer.alloc(4_800, 1);
    },
    outputAudio: { codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
  };
  const outcome = registerVoiceSessionMediaAdapters({
    registry,
    env,
    clock: new FakeClock(),
    ...(options.managed ? { managedTranscribe } : {}),
    ...(options.managedSynthesis ? { managedSynthesize: directPorts.synthesize } : {}),
    createDirectPorts: (input) => {
      directCalls.push(input);
      return directPorts;
    },
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { registry, outcome, logs, directCalls, managedCalls, directPorts };
}

function context(events: VoiceAdapterEvent[]): VoiceAdapterSessionContext {
  return {
    sessionId: "vs_test",
    chatId: "chat_test",
    principalId: "user_test",
    turnMode: "push_to_talk",
    memoryMode: "ordinary",
    audio: { codec: "pcm_s16le", sampleRateHz: 16_000, channels: 1, frameDurationMs: 20 },
    emit: (event) => events.push(event),
  };
}

function pcmS16Frame(amplitude: number, ms = 20, sampleRateHz = 16_000): string {
  const samples = Math.round((sampleRateHz * ms) / 1_000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(amplitude, i * 2);
  return buf.toString("base64");
}

async function flushAsync(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe("registerVoiceSessionMediaAdapters", () => {
  it("simulator flag wins over every other signal outside production and stays the only adapter", () => {
    const rig = run(
      {
        MATRIX_VOICE_SIMULATOR: "1",
        NODE_ENV: "development",
        ...DIRECT_ENV,
      },
      { managed: true },
    );
    expect(rig.outcome).toEqual({ adapterId: "simulator", reason: "simulator" });
    expect(rig.registry.size).toBe(1);
    expect(rig.registry.get("simulator")).toBeDefined();
    expect(rig.registry.default()!.id).toBe("simulator");
    // No provider port is even constructed under the simulator flag.
    expect(rig.directCalls).toHaveLength(0);
    expect(rig.logs.filter((entry) => entry.event === "voice.adapter.registration")).toHaveLength(1);
  });

  it("production denies the simulator flag and falls through to the managed adapter", () => {
    const rig = run(
      {
        MATRIX_VOICE_SIMULATOR: "1",
        NODE_ENV: "production",
        ...DIRECT_ENV,
      },
      { managed: true, managedSynthesis: true },
    );
    // The simulator must be structurally impossible in production: the
    // denial is logged and registration falls through to managed speech.
    expect(rig.outcome).toEqual({ adapterId: "managed", reason: "managed_platform_speech", synthesisSource: "platform" });
    expect(rig.registry.size).toBe(1);
    expect(rig.registry.get("simulator")).toBeUndefined();
    expect(rig.registry.get("managed")).toBeDefined();
    expect(rig.directCalls).toHaveLength(0);
    expect(rig.logs.some((entry) =>
      entry.event === "voice.adapter.simulator_ignored"
      && entry.fields.reason === "simulator_denied_production"
    )).toBe(true);
  });

  it("production + simulator-only registers nothing — the flag cannot fabricate an adapter", () => {
    const rig = run({ MATRIX_VOICE_SIMULATOR: "1", NODE_ENV: "production" });
    expect(rig.outcome).toEqual({ adapterId: null, reason: "not_configured" });
    expect(rig.registry.size).toBe(0);
    expect(rig.logs.some((entry) =>
      entry.event === "voice.adapter.simulator_ignored"
      && entry.fields.reason === "simulator_denied_production"
    )).toBe(true);
  });

  it("managed mode: platform transcription pairs with the dev-gated synthesizer outside production", async () => {
    const rig = run({ NODE_ENV: "development", ...DIRECT_ENV }, { managed: true });
    // Synthesis came from the dev gate — the readiness probe must know not
    // to adjudicate a platform synthesis leg this adapter never uses.
    expect(rig.outcome).toEqual({ adapterId: "managed", reason: "managed_platform_speech", synthesisSource: "external" });
    expect(rig.registry.size).toBe(1);
    // The dev gate is satisfied once — the direct factory saw a trimmed key
    // and the env-tunable model defaults.
    expect(rig.directCalls).toEqual([
      {
        apiKey: "sk-dev-key",
        transcriptionModel: "gpt-4o-mini-transcribe",
        speechModel: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    ]);

    // STT flows through the managed port; synthesis through the dev port.
    const adapter = rig.registry.get("managed")!;
    expect(adapter.capabilities.outputAudio)
      .toEqual({ codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 });
    const events: VoiceAdapterEvent[] = [];
    const session = await adapter.start(context(events));
    session.setCapture({ turnId: "vturn_1", mode: "push_to_talk" });
    session.pushAudio({ turnId: "vturn_1", timestampMs: 0, data: pcmS16Frame(8_000) });
    session.setCapture(null);
    session.synthesize({
      responseId: "vresp_1",
      segment: { segmentId: "vseg_1", segmentIndex: 0, textStart: 0, textEnd: 4, durationMs: 0 },
      text: "hi",
    });
    await flushAsync();

    expect(rig.managedCalls).toHaveLength(1);
    const wav = rig.managedCalls[0]!.wav;
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(16_000); // capture rate inside the WAV
    expect(rig.managedCalls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(events).toContainEqual({
      type: "transcript.final",
      turnId: "vturn_1",
      finalityId: "vfinal_vturn_1",
      text: "managed transcript",
    });
    const audio = events.filter((event) => event.type === "synthesis.audio");
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({
      segmentId: "vseg_1",
      format: { codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
    });
    expect(events).toContainEqual({
      type: "synthesis.end",
      responseId: "vresp_1",
      generatedDurationMs: 100,
      segmentId: "vseg_1",
    });
  });

  it("managed mode without a synthesis port registers nothing — never a hear-but-mute session", async () => {
    const rig = run({ NODE_ENV: "development" }, { managed: true });
    expect(rig.outcome).toEqual({ adapterId: null, reason: "managed_no_synthesis_port" });
    expect(rig.registry.size).toBe(0);
    expect(rig.directCalls).toHaveLength(0);
    // Capability stays truthful: unavailable, not configured.
    const capabilities = createAdapterCapabilityPort({
      registry: rig.registry,
      limits: { maxSessionSeconds: 3_600, maxIdleSeconds: 300 },
    });
    const capability = await capabilities.capabilities({ principalId: "user_1", chatId: "chat_1" });
    expect(capability.status).toBe("unavailable");
    expect(capability.reason).toBe("not_configured");
  });

  it("production + managed: the dev gate is denied so managed cannot speak — nothing registers", () => {
    const rig = run({ NODE_ENV: "production", ...DIRECT_ENV }, { managed: true });
    expect(rig.outcome).toEqual({ adapterId: null, reason: "managed_no_synthesis_port" });
    expect(rig.registry.size).toBe(0);
    expect(rig.directCalls).toHaveLength(0);
    expect(rig.logs.some((entry) => entry.event === "voice.adapter.direct_openai_ignored")).toBe(true);
  });

  it("production registers a fully managed adapter without constructing direct ports", () => {
    const rig = run({ NODE_ENV: "production" }, { managed: true, managedSynthesis: true });
    expect(rig.outcome).toEqual({ adapterId: "managed", reason: "managed_platform_speech", synthesisSource: "platform" });
    expect(rig.registry.get("managed")).toBeDefined();
    expect(rig.directCalls).toHaveLength(0);
  });

  it("direct mode: flag+key registers the openai adapter outside production", async () => {
    const rig = run({ NODE_ENV: "test", ...DIRECT_ENV });
    expect(rig.outcome).toEqual({ adapterId: "openai", reason: "direct_openai_dev" });
    expect(rig.registry.get("openai")).toBeDefined();
    expect(rig.registry.size).toBe(1);
    expect(rig.directCalls).toHaveLength(1);
    // The declared 24kHz output format projects to the wire capability.
    const capabilities = createAdapterCapabilityPort({
      registry: rig.registry,
      limits: { maxSessionSeconds: 3_600, maxIdleSeconds: 300 },
    });
    const capability = await capabilities.capabilities({ principalId: "user_1", chatId: "chat_1" });
    expect(capability.status).toBe("available");
    expect(capability.outputAudio).toEqual({ codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 });
  });

  it("production denies the direct flag+key with a warning and never builds ports", () => {
    const rig = run({ NODE_ENV: "production", ...DIRECT_ENV });
    expect(rig.outcome).toEqual({ adapterId: null, reason: "direct_openai_denied_production" });
    expect(rig.registry.size).toBe(0);
    expect(rig.directCalls).toHaveLength(0);
    expect(rig.logs.some((entry) => entry.event === "voice.adapter.direct_openai_ignored")).toBe(true);
  });

  it("a bare provider key without the dev flag registers nothing", () => {
    const rig = run({ NODE_ENV: "development", MATRIX_VOICE_OPENAI_API_KEY: "sk-lonely" });
    expect(rig.outcome).toEqual({ adapterId: null, reason: "direct_openai_incomplete_gate" });
    expect(rig.registry.size).toBe(0);
    expect(rig.directCalls).toHaveLength(0);
  });

  it("the dev flag without a key registers nothing", () => {
    const rig = run({ NODE_ENV: "development", MATRIX_VOICE_DIRECT_OPENAI: "1" });
    expect(rig.outcome).toEqual({ adapterId: null, reason: "direct_openai_incomplete_gate" });
    expect(rig.registry.size).toBe(0);
    expect(rig.directCalls).toHaveLength(0);
  });

  it("no configuration registers nothing — capability reports not_configured", async () => {
    const rig = run({ NODE_ENV: "development" });
    expect(rig.outcome).toEqual({ adapterId: null, reason: "not_configured" });
    expect(rig.registry.size).toBe(0);
    const capabilities = createAdapterCapabilityPort({
      registry: rig.registry,
      limits: { maxSessionSeconds: 3_600, maxIdleSeconds: 300 },
    });
    const capability = await capabilities.capabilities({ principalId: "user_1", chatId: "chat_1" });
    expect(capability.status).toBe("unavailable");
    expect(capability.reason).toBe("not_configured");
  });

  it("logs exactly one registration line naming adapter and reason", () => {
    const rig = run({ NODE_ENV: "test", ...DIRECT_ENV });
    const lines = rig.logs.filter((entry) => entry.event === "voice.adapter.registration");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.fields.adapter).toBe("openai");
    expect(lines[0]!.fields.reason).toBe("direct_openai_dev");
  });
});
