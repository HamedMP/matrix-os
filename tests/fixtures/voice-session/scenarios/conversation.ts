import { createVoiceSimulatorScenario } from "../media-simulator.js";

export const normalScenario = createVoiceSimulatorScenario("normal", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "capture", action: "start", turnId: "turn-1" },
  { atMs: 20, type: "vad", action: "speech_start", turnId: "turn-1" },
  { atMs: 30, type: "transcript.provisional", turnId: "turn-1", revision: 1, text: "private draft" },
  { atMs: 40, type: "vad", action: "speech_end", turnId: "turn-1" },
  { atMs: 50, type: "transcript.final", turnId: "turn-1", finalityId: "final-1", localOrder: 1, text: "private final" },
  { atMs: 60, type: "generation", action: "start", responseId: "response-1" },
  { atMs: 70, type: "synthesis.segment", responseId: "response-1", segmentId: "segment-1", segmentIndex: 0, durationMs: 240 },
  { atMs: 80, type: "playback", action: "start", responseId: "response-1" },
  { atMs: 90, type: "playback", action: "segment_played", responseId: "response-1", segmentId: "segment-1" },
  { atMs: 100, type: "generation", action: "complete", responseId: "response-1" },
  { atMs: 110, type: "playback", action: "stop", responseId: "response-1" },
  { atMs: 120, type: "end", reason: "user" },
]);

export const reorderedFinalsScenario = createVoiceSimulatorScenario("duplicate-reordered-finals", [
  { atMs: 20, type: "transcript.final", turnId: "turn-2", finalityId: "final-2", localOrder: 2, text: "second" },
  { atMs: 10, type: "transcript.final", turnId: "turn-1", finalityId: "final-1", localOrder: 1, text: "first" },
  { atMs: 20, type: "transcript.final", turnId: "turn-2-copy", finalityId: "final-2", localOrder: 2, text: "duplicate" },
  { atMs: 30, type: "end", reason: "user" },
]);

export const interruptionScenario = createVoiceSimulatorScenario("interruption", [
  { atMs: 0, type: "permission", outcome: "granted" },
  { atMs: 10, type: "generation", action: "start", responseId: "response-1" },
  { atMs: 20, type: "synthesis.segment", responseId: "response-1", segmentId: "segment-1", segmentIndex: 0, durationMs: 300 },
  { atMs: 30, type: "playback", action: "start", responseId: "response-1" },
  { atMs: 40, type: "interrupt", responseId: "response-1", source: "barge_in" },
  { atMs: 50, type: "playback", action: "segment_played", responseId: "response-1", segmentId: "segment-1" },
  { atMs: 60, type: "synthesis.segment", responseId: "response-1", segmentId: "segment-2", segmentIndex: 1, durationMs: 300 },
  { atMs: 70, type: "end", reason: "user" },
]);
