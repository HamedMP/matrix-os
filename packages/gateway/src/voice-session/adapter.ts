/**
 * Provider-neutral voice media adapter port.
 *
 * The engine owns session state; an adapter owns provider/realtime media.
 * Inbound adapter events (STT/VAD/synthesis) flow into the engine through
 * `VoiceAdapterSessionContext.emit`; outbound commands (capture, audio,
 * synthesis, cancel, interrupt) flow from engine to `VoiceMediaSession`.
 * Provider-native frames never cross this port — adapters translate to and
 * from the shared contract vocabulary.
 */
import { z } from "zod/v4";
import type {
  AudioFormat,
  ClientMediaCapabilities,
  SafeVoiceErrorCode,
  VoiceCapability,
  VoiceCapabilityLimits,
  VoiceRecoveryAction,
  VoiceResponseSegment,
  VoiceSessionLimits,
  VoiceTurnMode,
} from "@matrix-os/contracts/voice-session";
import type {
  VoiceCapabilityPort,
  VoiceClock,
  VoiceMemoryMode,
} from "./ports.js";
import type {
  VoiceSimulatorAction,
  VoiceSimulatorScenario,
} from "./simulator-types.js";
import { assertValidVoiceSimulatorScenario } from "./simulator-validation.js";

export const VoiceAdapterCapabilitiesSchema = z.object({
  transportModes: z.array(z.enum(["relayed_websocket", "direct_webrtc"])).min(1).max(2),
  turnModes: z.array(z.enum(["hands_free", "push_to_talk"])).min(1).max(2),
  supportsInterruption: z.boolean(),
  resume: z.enum(["delivery_aware", "rebuild_only", "unsupported"]),
  sessionOnly: z.enum(["enforced", "unsupported"]),
  actionMode: z.enum(["conversation_only", "safe_reads", "canonical_actions"]),
  actionCancellation: z.enum(["none", "run", "tool"]),
  supportsInputSelection: z.boolean(),
  supportsOutputSelection: z.boolean(),
}).strict();
export type VoiceAdapterCapabilities = z.infer<typeof VoiceAdapterCapabilitiesSchema>;

const ADAPTER_ID = /^[a-z][a-z0-9_-]{0,79}$/;

/** Events an adapter emits into the engine (provider → session). */
export type VoiceAdapterEvent =
  | { type: "vad"; turnId: string; action: "speech_start" | "speech_end" }
  | { type: "transcript.provisional"; turnId: string; revision: number; text: string }
  | {
      type: "transcript.final";
      turnId: string;
      /** Stable provider item identity used for dedup/reorder. */
      finalityId: string;
      text: string;
      /** Provider-declared truncation; engine keeps the turn editable. */
      truncated?: boolean;
    }
  | {
      /** Post-final text revision; presentation/provenance only. */
      type: "transcript.correction";
      turnId: string;
      finalityId: string;
      revision: number;
      text: string;
    }
  | {
      type: "synthesis.audio";
      responseId: string;
      segmentId: string;
      startMs: number;
      durationMs: number;
      /** Base64 audio bounded like `capture.audio` payloads. */
      data: string;
    }
  | { type: "synthesis.end"; responseId: string; generatedDurationMs: number }
  | { type: "error"; code: SafeVoiceErrorCode; retryable: boolean; fatal: boolean };

export interface VoiceSynthesisCommand {
  responseId: string;
  segment: VoiceResponseSegment;
  text: string;
}

/** Commands the engine issues to one provider/session projection. */
export interface VoiceMediaSession {
  /** Begin/end capture for a turn. `null` releases capture resources. */
  setCapture(capture: { turnId: string; mode: VoiceTurnMode } | null): void;
  /** Bounded base64 audio for the active capture turn. */
  pushAudio(input: { turnId: string; timestampMs: number; data: string }): void;
  /** Synthesize one canonical-text segment for playback. */
  synthesize(command: VoiceSynthesisCommand): void;
  /** Stop generation+queued audio for a response (generation cancel). */
  cancelResponse(responseId: string): void;
  /** Stop audible output immediately at a playback boundary (barge-in). */
  interrupt(responseId: string, playedThroughMs: number): void;
  /** Release the provider projection; idempotent. */
  close(): Promise<void> | void;
}

export interface VoiceAdapterSessionContext {
  sessionId: string;
  chatId: string;
  principalId: string;
  turnMode: VoiceTurnMode;
  memoryMode: VoiceMemoryMode;
  locale?: string;
  audio?: AudioFormat;
  clientCapabilities?: ClientMediaCapabilities;
  emit(event: VoiceAdapterEvent): void;
}

export interface VoiceMediaAdapter {
  readonly id: string;
  readonly capabilities: VoiceAdapterCapabilities;
  start(context: VoiceAdapterSessionContext): Promise<VoiceMediaSession> | VoiceMediaSession;
}

const DEFAULT_MAX_ADAPTERS = 16;

/**
 * Bounded adapter catalog. Registration validates id and capabilities up
 * front — adapters are server composition, never client/env-selected input.
 */
export class VoiceMediaAdapterRegistry {
  private readonly adapters = new Map<string, VoiceMediaAdapter>();
  private readonly maxAdapters: number;

  constructor(options: { maxAdapters?: number } = {}) {
    this.maxAdapters = options.maxAdapters ?? DEFAULT_MAX_ADAPTERS;
  }

  register(adapter: VoiceMediaAdapter): void {
    if (!adapter || typeof adapter.id !== "string" || !ADAPTER_ID.test(adapter.id)) {
      throw new TypeError("Voice adapter id must be a bounded safe slug");
    }
    // Registration-time validation: a malformed capability never reaches sessions.
    VoiceAdapterCapabilitiesSchema.parse(adapter.capabilities);
    if (typeof adapter.start !== "function") {
      throw new TypeError(`Voice adapter ${adapter.id} must implement start()`);
    }
    if (this.adapters.has(adapter.id)) {
      throw new RangeError(`Voice adapter ${adapter.id} is already registered`);
    }
    if (this.adapters.size >= this.maxAdapters) {
      throw new RangeError(`Voice adapter registry exceeds ${this.maxAdapters} adapters`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): VoiceMediaAdapter | undefined {
    return this.adapters.get(id);
  }

  /** First registered adapter is the default route until policy chooses. */
  default(): VoiceMediaAdapter | undefined {
    return this.adapters.values().next().value;
  }

  list(): readonly VoiceMediaAdapter[] {
    return [...this.adapters.values()];
  }

  get size(): number {
    return this.adapters.size;
  }
}

/**
 * Build a safe capability projection from registered adapters. Never leaks
 * adapter ids, provider names, endpoints, or upstream errors.
 */
export function createAdapterCapabilityPort(options: {
  registry: VoiceMediaAdapterRegistry;
  limits: VoiceCapabilityLimits;
  status?: "available" | "degraded";
  unavailableReason?: VoiceCapability extends { reason?: infer R } ? R : never;
  selectAdapter?: (input: { principalId: string; chatId: string }) => VoiceMediaAdapter | undefined;
}): VoiceCapabilityPort {
  const union = <T extends string>(pick: (caps: VoiceAdapterCapabilities) => readonly T[]): T[] => {
    const seen = new Set<T>();
    for (const adapter of options.registry.list()) for (const value of pick(adapter.capabilities)) seen.add(value);
    return [...seen];
  };
  const merge = (caps: VoiceAdapterCapabilities, surface?: string): VoiceCapability => ({
    contractVersion: 1,
    status: options.status ?? "available",
    surface: (surface ?? "web_desktop") as VoiceCapability["surface"],
    transportModes: union((c) => c.transportModes),
    turnModes: union((c) => c.turnModes),
    supportsInterruption: caps.supportsInterruption,
    resume: caps.resume,
    sessionOnly: caps.sessionOnly,
    actionMode: caps.actionMode,
    actionCancellation: caps.actionCancellation,
    supportsInputSelection: caps.supportsInputSelection,
    supportsOutputSelection: caps.supportsOutputSelection,
    limits: options.limits,
  });
  return {
    capabilities: (input) => {
      const adapter = (options.selectAdapter?.(input) ?? options.registry.default());
      if (!adapter) {
        return {
          contractVersion: 1,
          status: "unavailable",
          surface: (input.surface ?? "web_desktop") as VoiceCapability["surface"],
          transportModes: [],
          turnModes: [],
          supportsInterruption: false,
          resume: "unsupported",
          sessionOnly: "unsupported",
          actionMode: "conversation_only",
          actionCancellation: "none",
          supportsInputSelection: false,
          supportsOutputSelection: false,
          limits: options.limits,
          reason: options.unavailableReason ?? "not_configured",
        };
      }
      return merge(adapter.capabilities, input.surface);
    },
  };
}

const SIMULATOR_ERROR_CODES: Record<string, SafeVoiceErrorCode> = {
  input_lost: "input_unavailable",
  output_lost: "output_unavailable",
};

/**
 * Conforming media adapter over the Layer-1 deterministic simulator. Media-
 * side timeline actions (vad/transcripts/device/quota) are replayed through
 * `emit` at their `atMs` offsets on the injected clock; engine-side actions
 * (capture/playback/transport/…) are ignored — they belong to the transport
 * or canonical harness, not the provider port. Synthesis commands produce
 * small deterministic base64 frames so engine tests can assert the full
 * pending → audio → ack pipeline without real TTS.
 */
export class SimulatorVoiceMediaAdapter implements VoiceMediaAdapter {
  readonly id: string;
  readonly capabilities: VoiceAdapterCapabilities;
  private readonly scenario: VoiceSimulatorScenario;
  private readonly clock: VoiceClock;

  constructor(options: {
    scenario: VoiceSimulatorScenario;
    clock: VoiceClock;
    id?: string;
    capabilities?: Partial<VoiceAdapterCapabilities>;
  }) {
    assertValidVoiceSimulatorScenario(options.scenario);
    this.scenario = options.scenario;
    this.clock = options.clock;
    this.id = options.id ?? "simulator";
    this.capabilities = VoiceAdapterCapabilitiesSchema.parse({
      transportModes: ["relayed_websocket"],
      turnModes: ["hands_free", "push_to_talk"],
      supportsInterruption: true,
      resume: "rebuild_only",
      sessionOnly: "enforced",
      actionMode: "conversation_only",
      actionCancellation: "run",
      supportsInputSelection: true,
      supportsOutputSelection: true,
      ...options.capabilities,
    });
  }

  start(context: VoiceAdapterSessionContext): VoiceMediaSession {
    const timers = new Set<ReturnType<VoiceClock["after"]>>();
    const muted = new Set<string>();
    let closed = false;
    let synthesizedCount = 0;

    const schedule = (delayMs: number, fn: () => void) => {
      const timer = this.clock.after(delayMs, () => {
        timers.delete(timer);
        if (!closed) fn();
      });
      timers.add(timer);
    };

    const toEvent = (action: VoiceSimulatorAction): VoiceAdapterEvent | null => {
      switch (action.type) {
        case "vad":
          return { type: "vad", turnId: action.turnId, action: action.action };
        case "transcript.provisional":
          return { type: "transcript.provisional", turnId: action.turnId, revision: action.revision, text: action.text };
        case "transcript.final":
          return { type: "transcript.final", turnId: action.turnId, finalityId: action.finalityId, text: action.text };
        case "device": {
          if (action.action === "restored") return null;
          const code = SIMULATOR_ERROR_CODES[action.action] ?? "internal_failure";
          return { type: "error", code, retryable: true, fatal: false };
        }
        case "quota":
          return action.quota === "session"
            ? { type: "error", code: "session_limit_reached", retryable: false, fatal: true }
            : { type: "error", code: "usage_limit_reached", retryable: true, fatal: false };
        default:
          return null;
      }
    };

    for (const action of [...this.scenario.timeline].sort((a, b) => a.atMs - b.atMs)) {
      const event = toEvent(action);
      if (event) schedule(action.atMs, () => context.emit(event));
    }

    return {
      setCapture() {},
      pushAudio() {},
      synthesize: (command) => {
        if (closed || muted.has(command.responseId)) return;
        if (synthesizedCount >= 64) return;
        synthesizedCount += 1;
        const data = Buffer.from(`sim-segment-${command.segment.segmentIndex}`).toString("base64");
        schedule(0, () => {
          if (muted.has(command.responseId)) return;
          context.emit({
            type: "synthesis.audio",
            responseId: command.responseId,
            segmentId: command.segment.segmentId,
            startMs: 0,
            durationMs: command.segment.durationMs || 100,
            data,
          });
          context.emit({
            type: "synthesis.end",
            responseId: command.responseId,
            generatedDurationMs: command.segment.durationMs || 100,
          });
        });
      },
      cancelResponse: (responseId) => { muted.add(responseId); },
      interrupt: (responseId) => { muted.add(responseId); },
      close: () => {
        closed = true;
        for (const timer of timers) timer.cancel();
        timers.clear();
      },
    };
  }
}

/** Safe error → recovery pairing used by adapter error events. */
export const VOICE_ERROR_RECOVERY: Record<SafeVoiceErrorCode, VoiceRecoveryAction> = {
  permission_denied: "request_permission",
  input_unavailable: "choose_input",
  output_unavailable: "choose_output",
  connection_failed: "retry_connection",
  connection_lost: "retry_connection",
  provider_unavailable: "retry_connection",
  session_limit_reached: "start_new_session",
  usage_limit_reached: "continue_in_chat",
  audio_backpressure: "continue_in_chat",
  chat_unavailable: "continue_in_chat",
  session_conflict: "start_new_session",
  unsupported_surface: "continue_in_chat",
  internal_failure: "contact_support",
};
