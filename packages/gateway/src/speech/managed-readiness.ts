/**
 * Managed Platform-Speech readiness authority for voice surfaces.
 *
 * Registering the "managed" voice adapter only proves the process holds a
 * configured Platform Speech client — it says nothing about whether funded
 * transcription/streaming synthesis are actually usable. This module owns the
 * authoritative check behind a bounded, single-flight probe and a
 * `VoiceCapabilityPort` wrapper that fails closed:
 *
 * - `createManagedVoiceReadinessProbe` classifies live readiness as
 *   `ready | unready | timeout | unknown` through
 *   `classifyManagedVoiceSpeechReadiness`, bounded at `timeoutMs`
 *   (default 10s, clamped 1s–15s) by BOTH the probe's internal abort bound
 *   and an injectable `sleep` race so a dependency that ignores aborts can
 *   still not stall callers. Results cache asymmetrically: `ready` for the
 *   full `ttlMs` (default 30s, clamped 1s–5min), every non-ready state for
 *   `negativeTtlMs` (default 5s, clamped 0–ttlMs) so recovery is quick but
 *   callers cannot hammer the platform. Concurrent `probe()` calls share one
 *   in-flight request. No timers persist between probes: TTL expiry is lazy
 *   on read, and the per-probe `sleep` is a one-shot that fires into an
 *   already-settled race at worst.
 * - `wrapCapabilityPortWithReadiness` is the integration contract — wrap the
 *   adapter capability port ONCE at composition and every consumer (the REST
 *   capabilities route, session create, reconnect, and Aoede
 *   `resolveReadiness`) inherits the gate with no per-callsite changes. The
 *   probe is consulted only when the selected adapter id is the managed one;
 *   simulator/direct adapters keep their own capability truth. Any non-ready
 *   state — including a probe that throws — flattens the advertised
 *   capability through `unavailableManagedVoiceCapability` so no surface can
 *   admit a session against speech the platform cannot serve.
 */
import {
  VoiceCapabilitySchema,
  type VoiceCapability,
} from "@matrix-os/contracts/voice-session";
import type { VoiceCapabilityPort } from "../voice-session/ports.js";
import type { PlatformSpeechClient } from "./platform-client.js";
import {
  classifyManagedVoiceSpeechReadiness,
  type ManagedVoiceReadinessState,
} from "./voice-session-ports.js";

/** Adapter id `registerVoiceSessionMediaAdapters` gives the managed adapter
 * (`createOpenAiVoiceMediaAdapter({ id: "managed" })`). The probe only ever
 * describes this adapter's speech authority. */
export const MANAGED_VOICE_ADAPTER_ID = "managed";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_MS = 30_000;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface ManagedVoiceReadinessProbeResult {
  /** `ready` is the ONLY state that may admit voice work. */
  readonly state: ManagedVoiceReadinessState;
  /** Clock reading at which the classification settled. */
  readonly checkedAt: number;
}

export interface ManagedVoiceReadinessProbe {
  probe(): Promise<ManagedVoiceReadinessProbeResult>;
  /** Drop the cached classification; the next probe re-checks live. */
  invalidate(): void;
}

/**
 * Bounded single-flight readiness probe for the managed Platform Speech
 * client. O(1) state: one cached classification, one shared in-flight
 * promise. Only ever consult this for the managed adapter path.
 */
export function createManagedVoiceReadinessProbe(options: {
  client: Pick<PlatformSpeechClient, "capabilities">;
  /** Positive cache TTL; default 30s, clamped 1s–5min. */
  ttlMs?: number;
  /** Non-ready cache TTL; default 5s, clamped 0–ttlMs (0 = never cache). */
  negativeTtlMs?: number;
  /** Per-probe bound; default 10s, clamped 1s–15s. */
  timeoutMs?: number;
  /** Whose synthesis the managed adapter uses; default "platform". */
  synthesisSource?: "platform" | "external";
  now?: () => number;
  /** Test seam for the probe's own timeout race. */
  sleep?: (ms: number) => Promise<void>;
}): ManagedVoiceReadinessProbe {
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const ttlMs = clamp(options.ttlMs ?? DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
  const negativeTtlMs = clamp(options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS, 0, ttlMs);
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

  let cached:
    | { state: ManagedVoiceReadinessState; checkedAt: number; expiresAt: number }
    | undefined;
  let inFlight: Promise<ManagedVoiceReadinessProbeResult> | undefined;

  const run = async (): Promise<ManagedVoiceReadinessProbeResult> => {
    const bounded = classifyManagedVoiceSpeechReadiness({
      client: options.client,
      timeoutMs,
      ...(options.synthesisSource !== undefined ? { synthesisSource: options.synthesisSource } : {}),
      now,
    });
    const timedOut = sleep(timeoutMs).then((): ManagedVoiceReadinessProbeResult => ({
      state: "timeout",
      checkedAt: now(),
    }));
    let result: ManagedVoiceReadinessProbeResult;
    try {
      result = await Promise.race([bounded, timedOut]);
    } catch (error: unknown) {
      // `classify` never throws; an injected `sleep` might. Fail closed.
      console.warn(
        "[platform-speech] readiness probe bounded wait failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      result = { state: "unknown", checkedAt: now() };
    }
    cached = {
      state: result.state,
      checkedAt: result.checkedAt,
      expiresAt: result.checkedAt + (result.state === "ready" ? ttlMs : negativeTtlMs),
    };
    return { state: result.state, checkedAt: result.checkedAt };
  };

  return {
    probe() {
      const t = now();
      if (cached && t < cached.expiresAt) {
        return Promise.resolve({ state: cached.state, checkedAt: cached.checkedAt });
      }
      if (inFlight) return inFlight;
      const pending = run();
      inFlight = pending;
      // Clear the shared flight once it settles so a later probe can re-run;
      // the forked `.then` observes both settlements without masking the
      // result handed to callers.
      void pending.then(
        () => { if (inFlight === pending) inFlight = undefined; },
        () => { if (inFlight === pending) inFlight = undefined; },
      );
      return pending;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/**
 * Fail-closed capability for a managed adapter whose speech readiness is not
 * `ready`: schema-valid `unavailable` with emptied admission surfaces and the
 * existing `provider_unavailable` reason. Surface/limits stay truthful.
 */
export function unavailableManagedVoiceCapability(capability: VoiceCapability): VoiceCapability {
  return VoiceCapabilitySchema.parse({
    ...capability,
    status: "unavailable",
    transportModes: [],
    turnModes: [],
    supportsInterruption: false,
    resume: "unsupported",
    sessionOnly: "unsupported",
    actionMode: "conversation_only",
    actionCancellation: "none",
    supportsInputSelection: false,
    supportsOutputSelection: false,
    reason: "provider_unavailable",
  });
}

/**
 * Capability port that gates the wrapped port on managed speech readiness.
 * Consults the probe only when `selectedAdapterId` reports the managed
 * adapter AND the wrapped port claims any availability; every non-ready
 * answer flattens to `unavailableManagedVoiceCapability`. When
 * `selectedAdapterId` is omitted the selected adapter is assumed managed.
 */
export function wrapCapabilityPortWithReadiness(options: {
  port: VoiceCapabilityPort;
  probe: Pick<ManagedVoiceReadinessProbe, "probe">;
  selectedAdapterId?: (input: {
    principalId: string;
    chatId: string;
    surface?: string;
  }) => string | null | undefined | Promise<string | null | undefined>;
}): VoiceCapabilityPort {
  const selectedAdapterId = options.selectedAdapterId ?? (() => MANAGED_VOICE_ADAPTER_ID);
  return {
    async capabilities(input) {
      const capability = await options.port.capabilities(input);
      // Already fail-closed: the probe exists to add truth, not to "upgrade"
      // an unavailable report.
      if (capability.status === "unavailable") return capability;
      // The probe only describes managed speech readiness.
      if (await selectedAdapterId(input) !== MANAGED_VOICE_ADAPTER_ID) return capability;
      let state: ManagedVoiceReadinessState;
      try {
        state = (await options.probe.probe()).state;
      } catch (error: unknown) {
        console.warn(
          "[platform-speech] readiness probe unavailable",
          error instanceof Error ? error.name : "UnknownError",
        );
        state = "unknown";
      }
      if (state === "ready") return capability;
      return unavailableManagedVoiceCapability(capability);
    },
  };
}
