import { DeterministicVoiceSimulator } from "../../../../../packages/gateway/src/voice-session/simulator-adapter";
import type {
  VoiceSimulatorAction,
  VoiceSimulatorJournalEntry,
  VoiceSimulatorResult,
  VoiceSimulatorScenario,
} from "../../../../../packages/gateway/src/voice-session/simulator-adapter";
import {
  VoiceSessionController,
  type VoiceSessionCommand,
} from "../../../../../packages/ui/src/voice-session/controller";
import {
  FakeCanonicalChatHarness,
  type FakeCanonicalSnapshot,
} from "../../canonical-chat-harness";

export interface FixtureAdmissionEvidence {
  requestId: string;
  outcome: string;
  canonicalTurnId: string | null;
  canonicalQueuedTurnId: string | null;
  runId: string | null;
}

export interface FixtureEvidence {
  mediaScenarioId: string;
  mediaJournalEntries: number;
  mediaTerminalState: string;
  mediaDisplayCutMs: number | null;
  mediaResourcesClean: boolean;
  framesAccepted: number;
  framesRejected: number;
  admissions: FixtureAdmissionEvidence[];
  canonicalRevision: number;
  activeRunId: string | null;
  queuedRequestIds: readonly string[];
  operations: FakeCanonicalSnapshot["operations"];
  deliveries: FakeCanonicalSnapshot["deliveries"];
  commands: readonly string[];
  lastPlayedThroughMs: number;
}

export interface FixtureSessionRun {
  controller: VoiceSessionController;
  harness: FakeCanonicalChatHarness;
  media: VoiceSimulatorResult;
  evidence: FixtureEvidence;
}

export interface FixtureRunOptions {
  sessionId?: string;
  turnMode?: "hands_free" | "push_to_talk";
  displayUntilMs?: number;
  onCommand?: (command: VoiceSessionCommand) => void;
}

const turnId = (value: string) => `vturn_${value}`;
const finalityId = (value: string) => `vfinal_${value}`;
const responseId = (value: string) => `vresp_${value}`;
const segmentId = (value: string) => `vseg_${value}`;

function orderedActions(timeline: readonly VoiceSimulatorAction[]): VoiceSimulatorAction[] {
  return timeline
    .map((action, index) => ({ action, index }))
    .sort((left, right) => left.action.atMs - right.action.atMs || left.index - right.index)
    .map(({ action }) => action);
}

const ERROR_FRAMES: Record<string, { code: string; recovery: string; retryable: boolean }> = {
  "permission.denied": { code: "permission_denied", recovery: "request_permission", retryable: true },
  "permission.revoked": { code: "permission_denied", recovery: "request_permission", retryable: true },
  "session.duration_limit": { code: "session_limit_reached", recovery: "start_new_session", retryable: false },
  "session.failed": { code: "internal_failure", recovery: "continue_in_chat", retryable: true },
};

export function runFixtureSession(
  scenario: VoiceSimulatorScenario,
  options: FixtureRunOptions = {},
): FixtureSessionRun {
  const sessionId = options.sessionId ?? "vs_fixture";
  const harness = new FakeCanonicalChatHarness();
  const commands: VoiceSessionCommand[] = [];
  const controller = new VoiceSessionController({
    initialEpoch: scenario.initialEpoch,
    sessionId,
    initialTurnMode: options.turnMode,
    onCommand: (command) => {
      commands.push(command);
      options.onCommand?.(command);
    },
  });

  const media = new DeterministicVoiceSimulator().run(scenario);
  const timeline = orderedActions(scenario.timeline);
  const displayUntilMs = options.displayUntilMs ?? Number.POSITIVE_INFINITY;

  const admissions: FixtureAdmissionEvidence[] = [];
  const segmentDurations = new Map<string, number>();
  const playedThroughMs = new Map<string, number>();
  const deliveryRevisions = new Map<string, number>();
  const responseRunIds = new Map<string, string>();
  let lastSentRunId: string | null = null;
  let sequence = 0;
  let lastEpoch = scenario.initialEpoch;
  let framesAccepted = 0;
  let framesRejected = 0;

  const emit = (entry: VoiceSimulatorJournalEntry, body: Record<string, unknown>): void => {
    if (entry.epoch !== lastEpoch) {
      lastEpoch = entry.epoch;
      sequence = 0;
    }
    sequence += 1;
    const accepted = controller.receive({
      contractVersion: 1,
      sessionId,
      epoch: entry.epoch,
      sequence,
      ...body,
    });
    if (accepted) framesAccepted += 1;
    else framesRejected += 1;
  };

  const nextDeliveryRevision = (id: string): number => {
    const revision = (deliveryRevisions.get(id) ?? 0) + 1;
    deliveryRevisions.set(id, revision);
    return revision;
  };

  const recordDelivery = (id: string, state: "pending" | "complete" | "interrupted" | "unknown") => {
    harness.recordDelivery({ responseId: id, revision: nextDeliveryRevision(id), state });
  };

  const admit = (action: Extract<VoiceSimulatorAction, { type: "transcript.final" }>, replay: boolean) => {
    const result = harness.admit({
      requestId: `req_${action.finalityId}`,
      finalityId: finalityId(action.finalityId),
      source: "voice",
      localOrder: action.localOrder,
      baseRevision: harness.snapshot().revision,
      routeId: "route_fixture_agent",
      interactionMode: "default",
      permissionMode: "supervised",
      memoryMode: "session_only",
      choice: harness.snapshot().activeRunId === null ? "send" : "queue",
      transcript: action.text,
    });
    admissions.push({
      requestId: `req_${action.finalityId}`,
      outcome: replay ? `${result.outcome} (replayed)` : result.outcome,
      canonicalTurnId: result.canonicalTurnId ?? null,
      canonicalQueuedTurnId: result.canonicalQueuedTurnId ?? null,
      runId: result.runId ?? null,
    });
    return result;
  };

  let displayedEntries = 0;
  for (let index = 0; index < media.journal.length; index += 1) {
    const entry = media.journal[index];
    if (entry.atMs > displayUntilMs) break;
    displayedEntries += 1;
    const action = timeline[index];

    switch (entry.type) {
      case "transcript.provisional":
        if (action?.type === "transcript.provisional") {
          emit(entry, {
            type: "transcript.provisional",
            turnId: turnId(action.turnId),
            revision: action.revision,
            text: action.text,
          });
        }
        break;
      case "transcript.final":
        if (action?.type === "transcript.final") {
          const result = admit(action, false);
          if (result.canonicalTurnId !== undefined || result.canonicalQueuedTurnId !== undefined) {
            emit(entry, {
              type: "transcript.final",
              turnId: turnId(action.turnId),
              finalityId: finalityId(action.finalityId),
              ...(result.canonicalTurnId !== undefined ? { canonicalTurnId: result.canonicalTurnId } : {}),
              ...(result.canonicalQueuedTurnId !== undefined ? { canonicalQueuedTurnId: result.canonicalQueuedTurnId } : {}),
              localOrder: action.localOrder,
              text: action.text,
            });
          }
          if (result.runId !== undefined) lastSentRunId = result.runId;
        }
        break;
      case "transcript.final.duplicate_ignored":
        if (action?.type === "transcript.final") admit(action, true);
        break;
      case "generation.started": {
        if (action?.type !== "generation") break;
        const id = responseId(action.responseId);
        const runId = lastSentRunId ?? `run_${action.responseId}`;
        responseRunIds.set(id, runId);
        emit(entry, { type: "response.started", responseId: id, runId });
        recordDelivery(id, "pending");
        break;
      }
      case "generation.completed":
      case "generation.cancelled": {
        if (action?.type !== "generation") break;
        const id = responseId(action.responseId);
        harness.appendAssistantEvent({
          runId: responseRunIds.get(id) ?? `run_${action.responseId}`,
          eventId: `evt_${action.responseId}_${action.action}`,
          kind: "result",
        });
        break;
      }
      case "synthesis.segment":
        if (action?.type === "synthesis.segment") {
          const id = responseId(action.responseId);
          segmentDurations.set(`${id}\u0000${segmentId(action.segmentId)}`, action.durationMs);
          emit(entry, {
            type: "response.audio",
            responseId: id,
            segmentId: segmentId(action.segmentId),
            startMs: playedThroughMs.get(id) ?? 0,
            data: btoa(`fixture:${action.responseId}:${action.segmentId}`),
          });
        }
        break;
      case "playback.segment_played":
        if (action?.type === "playback" && action.segmentId !== undefined) {
          const id = responseId(action.responseId);
          const key = `${id}\u0000${segmentId(action.segmentId)}`;
          const heard = (playedThroughMs.get(id) ?? 0) + (segmentDurations.get(key) ?? 0);
          playedThroughMs.set(id, heard);
          controller.acknowledgePlayback({
            responseId: id,
            segmentId: segmentId(action.segmentId),
            deliveryRevision: nextDeliveryRevision(id),
            playedThroughMs: heard,
          });
        }
        break;
      case "response.interrupted":
        if (action?.type === "interrupt") {
          const id = responseId(action.responseId);
          emit(entry, {
            type: "response.interrupted",
            responseId: id,
            effectiveThroughMs: playedThroughMs.get(id) ?? 0,
          });
          recordDelivery(id, "interrupted");
        }
        break;
      case "playback.stopped":
        if (action?.type === "playback") recordDelivery(responseId(action.responseId), "complete");
        break;
      case "operation.status":
        if (action?.type === "operation") {
          const runId = harness.snapshot().activeRunId
            ?? responseRunIds.get(responseId(action.runId))
            ?? `run_${action.runId}`;
          const state = action.state;
          if (["running", "succeeded", "failed", "cancelled", "outcome_unknown"].includes(state)) {
            harness.recordOperation({
              operationId: action.operationId,
              idempotencyKey: `idem_${action.operationId}`,
              argumentDigest: `digest_${action.operationId}`,
              consequential: false,
              state: state as "running" | "succeeded" | "failed" | "cancelled" | "outcome_unknown",
            });
          }
          emit(entry, { type: "operation.status", runId, label: action.label, state });
        }
        break;
      case "transport.disconnected":
        emit(entry, { type: "transport.going_away", retryAfterMs: 0, reconnectAllowed: true });
        break;
      case "transport.reconnected":
        emit(entry, { type: "session.resumed", state: "listening", reason: "restored" });
        break;
      case "quota.reached":
        if (action?.type === "quota" && action.quota === "session") {
          emit(entry, {
            type: "session.error",
            code: "session_limit_reached",
            recovery: "start_new_session",
            retryable: false,
          });
        }
        break;
      default: {
        const errorFrame = ERROR_FRAMES[entry.type];
        if (errorFrame !== undefined) emit(entry, { type: "session.error", ...errorFrame });
        break;
      }
    }

    const endReason = action?.type === "end" && action.reason === "shutdown"
      ? "shutdown"
      : "user_requested";
    emit(entry, {
      type: "session.state",
      state: entry.sessionState,
      ...(entry.sessionState === "ended" ? { reason: endReason } : {}),
    });
  }

  const snapshot = harness.snapshot();
  const lastAck = [...commands].reverse().find((command) => command.type === "playback.segment_played");
  const evidence: FixtureEvidence = {
    mediaScenarioId: scenario.scenarioId,
    mediaJournalEntries: media.journal.length,
    mediaTerminalState: media.terminalState,
    mediaDisplayCutMs: displayedEntries < media.journal.length ? displayUntilMs : null,
    mediaResourcesClean:
      !media.resources.capture
      && !media.resources.transport
      && media.resources.playbackSegments === 0
      && media.resources.timers === 0
      && media.resources.queuedAudioMs === 0,
    framesAccepted,
    framesRejected,
    admissions,
    canonicalRevision: snapshot.revision,
    activeRunId: snapshot.activeRunId,
    queuedRequestIds: snapshot.queuedRequestIds,
    operations: snapshot.operations,
    deliveries: snapshot.deliveries,
    commands: commands.map((command) => command.type),
    lastPlayedThroughMs: lastAck?.type === "playback.segment_played" ? lastAck.playedThroughMs : 0,
  };

  return { controller, harness, media, evidence };
}
