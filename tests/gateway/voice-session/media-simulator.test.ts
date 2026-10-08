import { describe, expect, it } from "vitest";
import { DeterministicVoiceSimulator } from "../../../packages/gateway/src/voice-session/simulator-adapter.js";
import { createVoiceSimulatorScenario } from "../../fixtures/voice-session/media-simulator.js";
import {
  backpressureScenario,
  deviceLossScenario,
  durationLimitScenario,
  interruptionScenario,
  normalScenario,
  permissionDeniedScenario,
  quotaScenario,
  reconnectScenario,
  reorderedFinalsScenario,
  sessionQuotaScenario,
  terminalCleanupScenario,
} from "../../fixtures/voice-session/scenarios/index.js";

const CLEAN_RESOURCES = {
  capture: false,
  playbackSegments: 0,
  transport: false,
  timers: 0,
  queuedAudioMs: 0,
} as const;

function run(scenario = normalScenario) {
  return new DeterministicVoiceSimulator().run(scenario);
}

describe("DeterministicVoiceSimulator", () => {
  it("produces a stable redacted journal and clean normal terminal output", () => {
    expect(run()).toEqual({
      journal: [
        { atMs: 0, sequence: 1, type: "permission.granted", sessionState: "listening", epoch: 1, details: { outcome: "granted" } },
        { atMs: 10, sequence: 2, type: "capture.started", sessionState: "listening", epoch: 1, details: { turnId: "turn-1" } },
        { atMs: 20, sequence: 3, type: "vad.speech_start", sessionState: "listening", epoch: 1, details: { turnId: "turn-1" } },
        { atMs: 30, sequence: 4, type: "transcript.provisional", sessionState: "listening", epoch: 1, details: { revision: 1, textLength: 13, turnId: "turn-1" } },
        { atMs: 40, sequence: 5, type: "vad.speech_end", sessionState: "thinking", epoch: 1, details: { turnId: "turn-1" } },
        { atMs: 50, sequence: 6, type: "transcript.final", sessionState: "thinking", epoch: 1, details: { finalityId: "final-1", localOrder: 1, textLength: 13, turnId: "turn-1" } },
        { atMs: 60, sequence: 7, type: "generation.started", sessionState: "thinking", epoch: 1, details: { responseId: "response-1" } },
        { atMs: 70, sequence: 8, type: "synthesis.segment", sessionState: "thinking", epoch: 1, details: { durationMs: 240, responseId: "response-1", segmentId: "segment-1", segmentIndex: 0 } },
        { atMs: 80, sequence: 9, type: "playback.started", sessionState: "speaking", epoch: 1, details: { responseId: "response-1" } },
        { atMs: 90, sequence: 10, type: "playback.segment_played", sessionState: "speaking", epoch: 1, details: { responseId: "response-1", segmentId: "segment-1" } },
        { atMs: 100, sequence: 11, type: "generation.completed", sessionState: "speaking", epoch: 1, details: { responseId: "response-1" } },
        { atMs: 110, sequence: 12, type: "playback.stopped", sessionState: "listening", epoch: 1, details: { responseId: "response-1" } },
        { atMs: 120, sequence: 13, type: "session.ended", sessionState: "ended", epoch: 1, details: { reason: "user" } },
      ],
      resources: CLEAN_RESOURCES,
      terminalState: "ended",
    });
  });

  it("is deterministic and orders equal timestamps by declaration index", () => {
    expect(run(normalScenario)).toEqual(run(normalScenario));
    const result = run(reorderedFinalsScenario);
    expect(result.journal.slice(0, 3).map(entry => [entry.atMs, entry.type, entry.details.finalityId])).toEqual([
      [10, "transcript.final", "final-1"],
      [20, "transcript.final", "final-2"],
      [20, "transcript.final.duplicate_ignored", "final-2"],
    ]);
  });

  it("redacts transcript content and provisional revisions never emit admission semantics", () => {
    const result = run(createVoiceSimulatorScenario("provisional-only", [
      { atMs: 0, type: "transcript.provisional", turnId: "turn-secret", revision: 7, text: "do not journal me" },
      { atMs: 1, type: "end", reason: "user" },
    ]));
    expect(JSON.stringify(result.journal)).not.toContain("do not journal me");
    expect(result.journal[0]).toEqual({
      atMs: 0, sequence: 1, type: "transcript.provisional", sessionState: "connecting", epoch: 1,
      details: { revision: 7, textLength: 17, turnId: "turn-secret" },
    });
    expect(result.journal.some(entry => entry.type.includes("admit") || entry.type.includes("execut"))).toBe(false);
  });

  it("fences stale transport epochs and only reconnects with a newer epoch", () => {
    const result = run(reconnectScenario);
    expect(result.journal.slice(1, 5)).toEqual([
      { atMs: 10, sequence: 2, type: "transport.disconnected", sessionState: "reconnecting", epoch: 1, details: { epoch: 1 } },
      { atMs: 20, sequence: 3, type: "transport.reconnected", sessionState: "listening", epoch: 2, details: { epoch: 2 } },
      { atMs: 30, sequence: 4, type: "transport.stale_ignored", sessionState: "listening", epoch: 2, details: { action: "disconnect", currentEpoch: 2, epoch: 1 } },
      { atMs: 40, sequence: 5, type: "transport.stale_ignored", sessionState: "listening", epoch: 2, details: { action: "reconnect", currentEpoch: 2, epoch: 2 } },
    ]);
  });

  it("deduplicates final identities and played response segments", () => {
    const result = run(createVoiceSimulatorScenario("duplicates", [
      { atMs: 0, type: "transcript.final", turnId: "turn-1", finalityId: "final-1", localOrder: 1, text: "first" },
      { atMs: 1, type: "transcript.final", turnId: "turn-1", finalityId: "final-1", localOrder: 1, text: "first again" },
      { atMs: 2, type: "synthesis.segment", responseId: "response-1", segmentId: "segment-1", segmentIndex: 0, durationMs: 100 },
      { atMs: 3, type: "playback", action: "segment_played", responseId: "response-1", segmentId: "segment-1" },
      { atMs: 4, type: "playback", action: "segment_played", responseId: "response-1", segmentId: "segment-1" },
      { atMs: 5, type: "end", reason: "user" },
    ]));
    expect(result.journal.map(entry => entry.type)).toEqual([
      "transcript.final", "transcript.final.duplicate_ignored", "synthesis.segment",
      "playback.segment_played", "playback.segment_played.duplicate_ignored", "session.ended",
    ]);
  });

  it("interrupts playback and rejects late output for that response", () => {
    const result = run(interruptionScenario);
    expect(result.journal.slice(4, 7).map(entry => entry.type)).toEqual([
      "response.interrupted", "playback.interrupted_ignored", "synthesis.interrupted_ignored",
    ]);
    expect(result.journal[4]).toMatchObject({ sessionState: "listening", details: { responseId: "response-1", source: "barge_in" } });
    expect(result.resources).toEqual(CLEAN_RESOURCES);
  });

  it("pauses capture with explicit bounded backpressure and usage quota errors", () => {
    const backpressure = run(backpressureScenario);
    expect(backpressure.journal[2]).toEqual({
      atMs: 20, sequence: 3, type: "backpressure.limit", sessionState: "paused", epoch: 1,
      details: { errorCode: "audio_backpressure", limitMs: 1_000, queuedAudioMs: 1_000, recoverable: true },
    });
    const quota = run(quotaScenario);
    expect(quota.journal[2]).toMatchObject({
      type: "quota.reached", sessionState: "paused",
      details: { errorCode: "usage_limit_reached", quota: "usage", recoverable: true },
    });
  });

  it("handles permission, session quota, and device loss with safe failure or recovery", () => {
    expect(run(permissionDeniedScenario)).toEqual({
      journal: [{ atMs: 0, sequence: 1, type: "permission.denied", sessionState: "failed", epoch: 1, details: { errorCode: "permission_denied", outcome: "denied", recoverable: true } }],
      resources: CLEAN_RESOURCES,
      terminalState: "failed",
    });
    expect(run(sessionQuotaScenario).journal.at(-1)).toMatchObject({ type: "quota.reached", sessionState: "failed", details: { quota: "session", recoverable: true } });
    expect(run(deviceLossScenario).journal.slice(2, 4)).toEqual([
      { atMs: 20, sequence: 3, type: "device.input_lost", sessionState: "paused", epoch: 1, details: { errorCode: "input_unavailable", recoverable: true } },
      { atMs: 30, sequence: 4, type: "device.restored", sessionState: "listening", epoch: 1, details: { action: "restored" } },
    ]);
  });

  it("enforces the duration limit from virtual time before same-time actions", () => {
    const result = run(durationLimitScenario);
    expect(result.journal.at(-1)).toEqual({
      atMs: 100, sequence: 3, type: "session.duration_limit", sessionState: "failed", epoch: 1,
      details: { errorCode: "session_limit_reached", limitMs: 100, recoverable: false },
    });
    expect(result.journal.some(entry => entry.type === "capture.stopped")).toBe(false);
    expect(result.resources).toEqual(CLEAN_RESOURCES);
  });

  it("fires the duration limit on its own when no later action reaches the deadline", () => {
    const empty = run(createVoiceSimulatorScenario("empty", [], {
      limits: { maxQueuedAudioMs: 1_000, maxDurationMs: 250 },
    }));
    expect(empty.journal).toEqual([{
      atMs: 250,
      sequence: 1,
      type: "session.duration_limit",
      sessionState: "failed",
      epoch: 1,
      details: { errorCode: "session_limit_reached", limitMs: 250, recoverable: false },
    }]);
    expect(empty.resources).toEqual(CLEAN_RESOURCES);
    expect(empty.terminalState).toBe("failed");

    // An early-ending timeline still reaches the duration deadline and leaves
    // capture/transport/timers cleaned rather than live.
    const early = run(createVoiceSimulatorScenario("early-end", [
      { atMs: 0, type: "permission", outcome: "granted" },
      { atMs: 10, type: "capture", action: "start", turnId: "turn-1" },
    ], { limits: { maxQueuedAudioMs: 1_000, maxDurationMs: 500 } }));
    expect(early.journal.at(-1)).toMatchObject({
      atMs: 500,
      type: "session.duration_limit",
      sessionState: "failed",
    });
    expect(early.resources).toEqual(CLEAN_RESOURCES);
    expect(early.terminalState).toBe("failed");
  });

  it("runs idempotent cleanup for every terminal path", () => {
    const result = run(terminalCleanupScenario);
    expect(result.journal.slice(-2)).toEqual([
      { atMs: 40, sequence: 5, type: "session.failed", sessionState: "failed", epoch: 1, details: { reason: "failure" } },
      { atMs: 50, sequence: 6, type: "session.end_duplicate_ignored", sessionState: "failed", epoch: 1, details: { reason: "shutdown" } },
    ]);
    expect(result.resources).toEqual(CLEAN_RESOURCES);
    expect(result.terminalState).toBe("failed");
  });

  it("ignores late epoch-bound actions after a reconnect without mutating state", () => {
    const result = run(createVoiceSimulatorScenario("stale-epoch-events", [
      { atMs: 0, type: "transport", action: "disconnect", epoch: 1 },
      { atMs: 10, type: "transport", action: "reconnect", epoch: 2 },
      { atMs: 20, type: "transcript.provisional", epoch: 1, turnId: "turn-1", revision: 3, text: "late draft" },
      { atMs: 30, type: "transcript.final", epoch: 1, turnId: "turn-1", finalityId: "final-1", localOrder: 1, text: "late final" },
      { atMs: 40, type: "synthesis.segment", epoch: 1, responseId: "response-1", segmentId: "segment-1", segmentIndex: 0, durationMs: 100 },
      { atMs: 50, type: "capture", epoch: 1, action: "start", turnId: "turn-1" },
      { atMs: 60, type: "end", epoch: 1, reason: "failure" },
      { atMs: 70, type: "end", reason: "user" },
    ]));

    expect(result.journal.slice(2, -1).map((entry) => entry.type)).toEqual([
      "event.stale_epoch_ignored",
      "event.stale_epoch_ignored",
      "event.stale_epoch_ignored",
      "event.stale_epoch_ignored",
      "event.stale_epoch_ignored",
    ]);
    expect(result.journal[2]).toMatchObject({
      sessionState: "listening",
      epoch: 2,
      details: { actionType: "transcript.provisional", eventEpoch: 1, currentEpoch: 2 },
    });
    expect(result.journal.at(-1)).toMatchObject({ type: "session.ended", sessionState: "ended" });
    expect(result.terminalState).toBe("ended");
    expect(result.resources).toEqual(CLEAN_RESOURCES);
  });

  it("applies epoch-bound actions that still match the current epoch", () => {
    const result = run(createVoiceSimulatorScenario("matching-epoch", [
      { atMs: 0, type: "transcript.provisional", epoch: 1, turnId: "turn-1", revision: 1, text: "current" },
      { atMs: 10, type: "end", reason: "user" },
    ]));
    expect(result.journal[0]).toMatchObject({ type: "transcript.provisional", details: { revision: 1 } });
    expect(result.terminalState).toBe("ended");
  });

  it("rejects invalid or unbounded scenarios before allocating state", () => {
    const invalid: Array<{ name: string; scenario: unknown; error: typeof TypeError | typeof RangeError }> = [
      {
        name: "oversized timeline",
        scenario: createVoiceSimulatorScenario("too-long", Array(2_049).fill({ atMs: 0, type: "end", reason: "user" })),
        error: RangeError,
      },
      {
        name: "oversized transcript",
        scenario: createVoiceSimulatorScenario("big-text", [
          { atMs: 0, type: "transcript.provisional", turnId: "turn-1", revision: 0, text: "x".repeat(8_001) },
        ]),
        error: RangeError,
      },
      {
        name: "oversized transcript bytes",
        scenario: createVoiceSimulatorScenario("big-bytes", [
          { atMs: 0, type: "transcript.provisional", turnId: "turn-1", revision: 0, text: "😀".repeat(8_001) },
        ]),
        error: RangeError,
      },
      {
        name: "oversized identifier",
        scenario: createVoiceSimulatorScenario("big-id", [
          { atMs: 0, type: "capture", action: "start", turnId: "t".repeat(161) },
        ]),
        error: RangeError,
      },
      {
        name: "zero initial epoch",
        scenario: createVoiceSimulatorScenario("zero-epoch", [], { initialEpoch: 0 }),
        error: RangeError,
      },
      {
        name: "fractional initial epoch",
        scenario: createVoiceSimulatorScenario("frac-epoch", [], { initialEpoch: 1.5 }),
        error: TypeError,
      },
      {
        name: "negative timestamp",
        scenario: createVoiceSimulatorScenario("neg-at", [{ atMs: -1, type: "end", reason: "user" }]),
        error: RangeError,
      },
      {
        name: "zero queue limit",
        scenario: createVoiceSimulatorScenario("zero-queue", [], { limits: { maxQueuedAudioMs: 0, maxDurationMs: 1_000 } }),
        error: RangeError,
      },
      {
        name: "queue limit above global cap",
        scenario: createVoiceSimulatorScenario("huge-queue", [], { limits: { maxQueuedAudioMs: 10_001, maxDurationMs: 1_000 } }),
        error: RangeError,
      },
      {
        name: "duration limit above global cap",
        scenario: createVoiceSimulatorScenario("huge-duration", [], { limits: { maxQueuedAudioMs: 1_000, maxDurationMs: 3_600_001 } }),
        error: RangeError,
      },
      {
        name: "backpressure above global cap",
        scenario: createVoiceSimulatorScenario("huge-backpressure", [
          { atMs: 0, type: "backpressure", queuedAudioMs: 10_001 },
        ]),
        error: RangeError,
      },
      {
        name: "stale action epoch zero",
        scenario: createVoiceSimulatorScenario("zero-action-epoch", [
          { atMs: 0, type: "end", epoch: 0, reason: "user" },
        ]),
        error: RangeError,
      },
      {
        name: "transport epoch zero",
        scenario: createVoiceSimulatorScenario("zero-transport-epoch", [
          { atMs: 0, type: "transport", action: "reconnect", epoch: 0 },
        ]),
        error: RangeError,
      },
      {
        name: "unknown action type",
        scenario: createVoiceSimulatorScenario("unknown", [{ atMs: 0, type: "mystery" } as never]),
        error: TypeError,
      },
      {
        name: "non-object action",
        scenario: createVoiceSimulatorScenario("raw", ["not-an-action" as never]),
        error: TypeError,
      },
      {
        name: "missing timeline",
        scenario: { scenarioId: "no-timeline", version: 1, initialEpoch: 1, limits: { maxQueuedAudioMs: 1_000, maxDurationMs: 1_000 } },
        error: TypeError,
      },
      {
        name: "unknown scenario key",
        scenario: { ...createVoiceSimulatorScenario("extra-key", []), provider: "openai" },
        error: TypeError,
      },
      {
        name: "unknown limits key",
        scenario: createVoiceSimulatorScenario("extra-limit", [], {
          limits: { maxQueuedAudioMs: 1_000, maxDurationMs: 1_000, maxRetries: 3 } as never,
        }),
        error: TypeError,
      },
      {
        name: "unknown action key",
        scenario: createVoiceSimulatorScenario("extra-action-key", [
          { atMs: 0, type: "end", reason: "user", severity: "high" } as never,
        ]),
        error: TypeError,
      },
      {
        name: "segment index above cap",
        scenario: createVoiceSimulatorScenario("big-segment-index", [
          { atMs: 0, type: "synthesis.segment", responseId: "response-1", segmentId: "segment-1", segmentIndex: 512, durationMs: 10 },
        ]),
        error: RangeError,
      },
      {
        name: "segment duration above cap",
        scenario: createVoiceSimulatorScenario("big-segment-duration", [
          { atMs: 0, type: "synthesis.segment", responseId: "response-1", segmentId: "segment-1", segmentIndex: 0, durationMs: 3_600_001 },
        ]),
        error: RangeError,
      },
      {
        name: "action timestamp above the scenario duration",
        scenario: createVoiceSimulatorScenario("past-deadline", [
          { atMs: 101, type: "end", reason: "user" },
        ], { limits: { maxQueuedAudioMs: 1_000, maxDurationMs: 100 } }),
        error: RangeError,
      },
      {
        name: "operation state outside the canonical enum",
        scenario: createVoiceSimulatorScenario("bad-operation-state", [
          { atMs: 0, type: "operation", operationId: "op-1", runId: "run-1", label: "Read files", state: "exploded" } as never,
        ]),
        error: TypeError,
      },
    ];

    for (const { name, scenario, error } of invalid) {
      expect(() => run(scenario as never), name).toThrow(error);
    }

    // Backpressure above the scenario queue limit but under the global cap is legal.
    const bounded = run(createVoiceSimulatorScenario("legal-over-limit", [
      { atMs: 0, type: "backpressure", queuedAudioMs: 5_000 },
      { atMs: 10, type: "end", reason: "user" },
    ]));
    expect(bounded.journal[0]).toMatchObject({ type: "backpressure.limit", details: { queuedAudioMs: 1_000 } });
  });
});
