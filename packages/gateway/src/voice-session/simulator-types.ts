import type { CanonicalOperationState } from "@matrix-os/contracts/voice-session";

type EpochBoundAction = { epoch?: number };

export type VoiceSimulatorAction = EpochBoundAction & (
  | { atMs: number; type: "permission"; outcome: "granted" | "denied" | "revoked" }
  | { atMs: number; type: "capture"; action: "start" | "stop"; turnId: string }
  | { atMs: number; type: "vad"; action: "speech_start" | "speech_end"; turnId: string }
  | { atMs: number; type: "transcript.provisional"; turnId: string; revision: number; text: string }
  | { atMs: number; type: "transcript.final"; turnId: string; finalityId: string; localOrder: number; text: string }
  | { atMs: number; type: "generation"; action: "start" | "cancel" | "complete"; responseId: string }
  | { atMs: number; type: "synthesis.segment"; responseId: string; segmentId: string; segmentIndex: number; durationMs: number }
  | { atMs: number; type: "playback"; action: "start" | "segment_played" | "stop"; responseId: string; segmentId?: string }
  | { atMs: number; type: "interrupt"; responseId: string; source: "user" | "barge_in" }
  | { atMs: number; type: "transport"; action: "disconnect" | "reconnect"; epoch: number }
  | { atMs: number; type: "backpressure"; queuedAudioMs: number }
  | { atMs: number; type: "quota"; quota: "session" | "usage" }
  | { atMs: number; type: "device"; action: "input_lost" | "output_lost" | "restored" }
  | { atMs: number; type: "operation"; operationId: string; runId: string; label: string; state: CanonicalOperationState }
  | { atMs: number; type: "end"; reason: "user" | "failure" | "shutdown" }
);

export interface VoiceSimulatorScenario {
  scenarioId: string;
  version: 1;
  initialEpoch: number;
  limits: { maxQueuedAudioMs: number; maxDurationMs: number };
  timeline: readonly VoiceSimulatorAction[];
}

export interface VoiceSimulatorJournalEntry {
  atMs: number;
  sequence: number;
  type: string;
  sessionState: string;
  epoch: number;
  details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface VoiceSimulatorResult {
  journal: readonly VoiceSimulatorJournalEntry[];
  resources: {
    capture: boolean;
    playbackSegments: number;
    transport: boolean;
    timers: number;
    queuedAudioMs: number;
  };
  terminalState: string;
}
