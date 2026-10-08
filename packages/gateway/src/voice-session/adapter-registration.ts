/**
 * Voice media adapter registration policy (composition seam).
 *
 * Env → adapter matrix, exactly one startup log line naming the outcome:
 *
 * | MATRIX_VOICE_SIMULATOR | Platform Speech client | MATRIX_VOICE_DIRECT_OPENAI=1 + MATRIX_VOICE_OPENAI_API_KEY | NODE_ENV | adapter |
 * |---|---|---|---|---|
 * | `1` | any | any | ≠production | `simulator` (explicit dev/integration seam — ONLY adapter) |
 * | `1` | any | any | production | simulator denied + logged; the managed/direct rows decide |
 * | unset | provisioned STT+TTS | any | any | `managed`: platform speech |
 * | unset | provisioned STT only | complete gate | ≠production | `managed`: platform STT + dev synthesizer |
 * | unset | provisioned STT only | incomplete or ignored | any | none — no synthesis port |
 * | unset | absent | complete gate | ≠production | `openai` direct (development escape hatch) |
 * | unset | absent | flag+key present | production | none — key authority denied, warning logged |
 * | unset | absent | flag XOR key | any | none — incomplete gate, logged |
 * | unset | absent | neither | any | none — capability reports `not_configured` |
 *
 * Invariants (speech/DOMAIN.md):
 * - A production gateway NEVER holds provider keys: `MATRIX_VOICE_DIRECT_OPENAI`
 *   + `MATRIX_VOICE_OPENAI_API_KEY` are ignored with a warning when
 *   `NODE_ENV === "production"` — funding/policy/metering live platform-side.
 * - A managed adapter registers only when both STT and TTS exist. Development
 *   may supply its explicitly gated synthesizer as a fallback; production
 *   never does.
 * - Outside production the simulator flag always wins and stays the ONLY
 *   adapter, so a stray provider key can never silently route dev sessions to
 *   paid calls. Production evaluates first: `MATRIX_VOICE_SIMULATOR=1` is
 *   denied and logged there — it can never fabricate, mask, or replace the
 *   managed/direct decision.
 */
import {
  SimulatorVoiceMediaAdapter,
  type VoiceMediaAdapterRegistry,
} from "./adapter.js";
import {
  createDirectOpenAiSpeechPorts,
  type DirectOpenAiSpeechPortOptions,
} from "./direct-openai-ports.js";
import { createOpenAiVoiceMediaAdapter } from "./openai-adapter.js";
import {
  createSystemVoiceClock,
  type VoiceClock,
} from "./ports.js";
import type { VoiceSpeechPorts, VoiceSynthesisPort, VoiceTranscriptionPort } from "./speech-ports.js";

export type VoiceAdapterRegistrationReason =
  | "simulator"
  | "managed_platform_speech"
  | "managed_no_synthesis_port"
  | "direct_openai_dev"
  | "direct_openai_denied_production"
  | "direct_openai_incomplete_gate"
  | "not_configured";

export interface VoiceAdapterRegistrationOutcome {
  /** Registered adapter id, or null when nothing registered. */
  adapterId: string | null;
  reason: VoiceAdapterRegistrationReason;
  /**
   * Whose synthesis a registered `managed` adapter uses: `"platform"` when
   * the provisioned client supplies it, `"external"` when a development-gated
   * port filled the synthesis leg. Absent for every other outcome — the
   * readiness probe keys off this so it never adjudicates a platform leg the
   * adapter does not use.
   */
  synthesisSource?: "platform" | "external";
}

/**
 * Register the single voice media adapter selected by env policy.
 * `managedTranscribe` is the provisioned Platform Speech port (absent when
 * platform speech is unprovisioned); `createDirectPorts` is injectable so
 * tests never build fetch-backed ports.
 */
export function registerVoiceSessionMediaAdapters(options: {
  registry: VoiceMediaAdapterRegistry;
  env?: NodeJS.ProcessEnv;
  managedTranscribe?: VoiceTranscriptionPort;
  managedSynthesize?: VoiceSynthesisPort;
  createDirectPorts?: (input: DirectOpenAiSpeechPortOptions) => VoiceSpeechPorts;
  clock?: VoiceClock;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): VoiceAdapterRegistrationOutcome {
  const env = options.env ?? process.env;
  const log = options.log
    ?? ((event: string, fields: Record<string, unknown>) => console.warn("[voice-session]", event, fields));
  const clock = options.clock ?? createSystemVoiceClock();
  const createDirect = options.createDirectPorts ?? createDirectOpenAiSpeechPorts;
  const done = (adapterId: string | null, reason: VoiceAdapterRegistrationReason, detail: string,
    synthesisSource?: "platform" | "external"): VoiceAdapterRegistrationOutcome => {
    log("voice.adapter.registration", { adapter: adapterId ?? "none", reason, detail });
    return { adapterId, reason, ...(synthesisSource !== undefined ? { synthesisSource } : {}) };
  };

  // Production is evaluated before every dev seam: the simulator and the
  // direct-provider escape hatch are structurally impossible there.
  const production = env.NODE_ENV === "production";

  if (env.MATRIX_VOICE_SIMULATOR === "1") {
    if (!production) {
      options.registry.register(new SimulatorVoiceMediaAdapter({
        scenario: {
          scenarioId: "matrix-voice-sim",
          version: 1,
          initialEpoch: 1,
          limits: { maxQueuedAudioMs: 10_000, maxDurationMs: 3_600_000 },
          timeline: [],
        },
        clock,
      }));
      return done("simulator", "simulator", "MATRIX_VOICE_SIMULATOR=1 selects the deterministic simulator as the only adapter");
    }
    log("voice.adapter.simulator_ignored", {
      reason: "simulator_denied_production",
      detail: "MATRIX_VOICE_SIMULATOR is a development seam; it can never fabricate a media adapter in production",
    });
  }

  const directFlag = env.MATRIX_VOICE_DIRECT_OPENAI === "1";
  const directKey = env.MATRIX_VOICE_OPENAI_API_KEY?.trim();

  if (production && (directFlag || directKey)) {
    log("voice.adapter.direct_openai_ignored", {
      reason: "production_denied",
      detail: "Provider keys on the gateway are a development escape hatch and are ignored in production; speech funding/policy live behind Platform Speech",
    });
  }

  const directPorts = !production && directFlag && directKey
    ? createDirect({
        apiKey: directKey,
        transcriptionModel: env.MATRIX_VOICE_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
        speechModel: env.MATRIX_VOICE_SPEECH_MODEL ?? "gpt-4o-mini-tts",
        voice: env.MATRIX_VOICE_SPEECH_VOICE ?? "alloy",
      })
    : undefined;

  if (options.managedTranscribe) {
    const synthesis = options.managedSynthesize ?? directPorts?.synthesize;
    if (synthesis) {
      const adapter = createOpenAiVoiceMediaAdapter({
        id: "managed",
        speech: {
          transcribe: options.managedTranscribe,
          synthesize: synthesis,
          outputAudio: { codec: "pcm_s16le", sampleRateHz: 24_000, channels: 1 },
        },
        clock,
      });
      options.registry.register(adapter);
      return done(adapter.id, "managed_platform_speech", options.managedSynthesize
        ? "platform-managed transcription and synthesis"
        : "platform-managed transcription with a development-gated synthesis port",
        options.managedSynthesize ? "platform" : "external");
    }
    return done(null, "managed_no_synthesis_port", "platform speech is provisioned but no synthesis port exists (no platform TTS endpoint; dev synthesis gate unset or denied)");
  }

  if (directFlag && directKey) {
    if (production) {
      return done(null, "direct_openai_denied_production", "direct provider key authority denied in production");
    }
    if (directPorts) {
      const adapter = createOpenAiVoiceMediaAdapter({ speech: directPorts, clock });
      options.registry.register(adapter);
      return done(adapter.id, "direct_openai_dev", "development direct-provider escape hatch");
    }
  }

  if (directFlag || directKey) {
    return done(null, "direct_openai_incomplete_gate", `direct path needs MATRIX_VOICE_DIRECT_OPENAI=1 AND MATRIX_VOICE_OPENAI_API_KEY (flag=${directFlag}, key=${directKey ? "set" : "unset"})`);
  }

  return done(null, "not_configured", "no voice media adapter configured; capability reports not_configured");
}
