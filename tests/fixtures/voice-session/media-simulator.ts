import type {
  VoiceSimulatorAction,
  VoiceSimulatorScenario,
} from "../../../packages/gateway/src/voice-session/simulator-adapter.js";

const DEFAULT_LIMITS = {
  maxQueuedAudioMs: 1_000,
  maxDurationMs: 60_000,
} as const;

export function createVoiceSimulatorScenario(
  scenarioId: string,
  timeline: readonly VoiceSimulatorAction[],
  overrides: Partial<Omit<VoiceSimulatorScenario, "scenarioId" | "timeline" | "version">> = {},
): VoiceSimulatorScenario {
  return {
    scenarioId,
    version: 1,
    initialEpoch: overrides.initialEpoch ?? 1,
    limits: overrides.limits ?? DEFAULT_LIMITS,
    timeline,
  };
}

export function action<T extends VoiceSimulatorAction>(value: T): T {
  return value;
}
