/**
 * Voice media adapter registration policy (composition seam).
 *
 * Env → adapter matrix, exactly one startup log line naming the outcome:
 *
 * | MATRIX_VOICE_SIMULATOR | Platform Speech client | MATRIX_VOICE_DIRECT_OPENAI=1 + MATRIX_VOICE_OPENAI_API_KEY | NODE_ENV | adapter |
 * |---|---|---|---|---|
 * | `1` | any | any | any | `simulator` (explicit dev/integration seam — ONLY adapter) |
 * | unset | provisioned | complete gate | ≠production | `managed`: platform STT + dev-gated synthesizer |
 * | unset | provisioned | incomplete or ignored | any | none — managed STT exists but no synthesis port |
 * | unset | absent | complete gate | ≠production | `openai` direct (development escape hatch) |
 * | unset | absent | flag+key present | production | none — key authority denied, warning logged |
 * | unset | absent | flag XOR key | any | none — incomplete gate, logged |
 * | unset | absent | neither | any | none — capability reports `not_configured` |
 *
 * Invariants (speech/DOMAIN.md):
 * - A production gateway NEVER holds provider keys: `MATRIX_VOICE_DIRECT_OPENAI`
 *   + `MATRIX_VOICE_OPENAI_API_KEY` are ignored with a warning when
 *   `NODE_ENV === "production"` — funding/policy/metering live platform-side.
 * - No platform TTS/synthesis endpoint exists (contracts model file
 *   transcription only), so a managed adapter registers ONLY when a
 *   dev-scoped synthesizer port is also available; otherwise nothing
 *   registers and capability truthfully reports `not_configured` rather
 *   than admitting a session that hears but never speaks.
 * - The simulator flag always wins and stays the ONLY adapter, so a stray
 *   provider key can never silently route dev sessions to paid calls.
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
import type { VoiceSpeechPorts, VoiceTranscriptionPort } from "./speech-ports.js";

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
  createDirectPorts?: (input: DirectOpenAiSpeechPortOptions) => VoiceSpeechPorts;
  clock?: VoiceClock;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): VoiceAdapterRegistrationOutcome {
  const env = options.env ?? process.env;
  const log = options.log
    ?? ((event: string, fields: Record<string, unknown>) => console.warn("[voice-session]", event, fields));
  const clock = options.clock ?? createSystemVoiceClock();
  const createDirect = options.createDirectPorts ?? createDirectOpenAiSpeechPorts;
  const done = (adapterId: string | null, reason: VoiceAdapterRegistrationReason, detail: string): VoiceAdapterRegistrationOutcome => {
    log("voice.adapter.registration", { adapter: adapterId ?? "none", reason, detail });
    return { adapterId, reason };
  };

  if (env.MATRIX_VOICE_SIMULATOR === "1") {
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

  const production = env.NODE_ENV === "production";
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
    if (directPorts) {
      const adapter = createOpenAiVoiceMediaAdapter({
        id: "managed",
        speech: {
          transcribe: options.managedTranscribe,
          synthesize: directPorts.synthesize,
          ...(directPorts.outputAudio ? { outputAudio: directPorts.outputAudio } : {}),
        },
        clock,
      });
      options.registry.register(adapter);
      return done(adapter.id, "managed_platform_speech", "platform-managed transcription with a development-gated synthesis port");
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
