import { createVoiceSimulatorScenario } from "../media-simulator.js";

export const reconnectScenario = createVoiceSimulatorScenario("reconnect-stale-epoch", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "transport", action: "disconnect", epoch: 1 },
  { atMs: 20, type: "transport", action: "reconnect", epoch: 2 },
  { atMs: 30, type: "transport", action: "disconnect", epoch: 1 },
  { atMs: 40, type: "transport", action: "reconnect", epoch: 2 },
  { atMs: 50, type: "end", reason: "user" },
], { initialEpoch: 1 });

export const deviceLossScenario = createVoiceSimulatorScenario("device-loss", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "capture", action: "start", turnId: "turn-1" },
  { atMs: 20, type: "device", action: "input_lost" },
  { atMs: 30, type: "device", action: "restored" },
  { atMs: 40, type: "end", reason: "user" },
]);

export const permissionDeniedScenario = createVoiceSimulatorScenario("permission-denied", [
  { atMs: 0, type: "permission", outcome: "denied" },
]);

export const terminalCleanupScenario = createVoiceSimulatorScenario("terminal-cleanup", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "capture", action: "start", turnId: "turn-1" },
  { atMs: 20, type: "backpressure", queuedAudioMs: 400 },
  { atMs: 30, type: "synthesis.segment", responseId: "response-1", segmentId: "segment-1", segmentIndex: 0, durationMs: 200 },
  { atMs: 40, type: "end", reason: "failure" },
  { atMs: 50, type: "end", reason: "shutdown" },
]);
