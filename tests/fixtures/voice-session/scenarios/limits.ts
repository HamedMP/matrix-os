import { createVoiceSimulatorScenario } from "../media-simulator.js";

export const backpressureScenario = createVoiceSimulatorScenario("backpressure", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "capture", action: "start", turnId: "turn-1" },
  { atMs: 20, type: "backpressure", queuedAudioMs: 1_000 },
  { atMs: 30, type: "end", reason: "user" },
]);

export const quotaScenario = createVoiceSimulatorScenario("quota", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "capture", action: "start", turnId: "turn-1" },
  { atMs: 20, type: "quota", quota: "usage" },
  { atMs: 30, type: "end", reason: "user" },
]);

export const sessionQuotaScenario = createVoiceSimulatorScenario("session-quota", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "quota", quota: "session" },
]);

export const durationLimitScenario = createVoiceSimulatorScenario("duration-limit", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 99, type: "capture", action: "start", turnId: "turn-1" },
  { atMs: 100, type: "capture", action: "stop", turnId: "turn-1" },
], { limits: { maxQueuedAudioMs: 1_000, maxDurationMs: 100 } });
