import type { VoiceSimulatorScenario } from "./simulator-types.js";

export const VOICE_SIMULATOR_LIMITS = {
  maxTimelineActions: 2_048,
  maxTranscriptChars: 8_000,
  maxTranscriptBytes: 32_000,
  maxIdChars: 160,
  maxQueuedAudioMs: 10_000,
  maxDurationMs: 3_600_000,
  maxSegments: 512,
  maxOperationLabelChars: 120,
} as const;

const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireIdentifier(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (value.length > VOICE_SIMULATOR_LIMITS.maxIdChars) {
    throw new RangeError(`${field} exceeds ${VOICE_SIMULATOR_LIMITS.maxIdChars} characters`);
  }
}

function requireNonNegativeSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  if (value < 0) {
    throw new RangeError(`${field} must be non-negative`);
  }
}

function requirePositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be a safe integer`);
  }
  if (value <= 0) {
    throw new RangeError(`${field} must be positive`);
  }
}

function requireBoundedNonNegative(value: unknown, field: string, maximum: number): void {
  requireNonNegativeSafeInteger(value, field);
  if (value > maximum) {
    throw new RangeError(`${field} exceeds ${maximum}`);
  }
}

function requireTranscript(value: unknown, field: string): void {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if ([...value].length > VOICE_SIMULATOR_LIMITS.maxTranscriptChars) {
    throw new RangeError(`${field} exceeds ${VOICE_SIMULATOR_LIMITS.maxTranscriptChars} characters`);
  }
  if (textEncoder.encode(value).byteLength > VOICE_SIMULATOR_LIMITS.maxTranscriptBytes) {
    throw new RangeError(`${field} exceeds ${VOICE_SIMULATOR_LIMITS.maxTranscriptBytes} bytes`);
  }
}

function requireEnum(value: unknown, field: string, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(", ")}`);
  }
}

function requireLabel(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if ([...value].length > VOICE_SIMULATOR_LIMITS.maxOperationLabelChars) {
    throw new RangeError(`${field} exceeds ${VOICE_SIMULATOR_LIMITS.maxOperationLabelChars} characters`);
  }
}

const CANONICAL_OPERATION_STATES = [
  "queued",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "outcome_unknown",
] as const;

const ACTION_FIELDS: Record<string, readonly string[]> = {
  permission: ["atMs", "type", "epoch", "outcome"],
  capture: ["atMs", "type", "epoch", "action", "turnId"],
  vad: ["atMs", "type", "epoch", "action", "turnId"],
  "transcript.provisional": ["atMs", "type", "epoch", "turnId", "revision", "text"],
  "transcript.final": ["atMs", "type", "epoch", "turnId", "finalityId", "localOrder", "text"],
  generation: ["atMs", "type", "epoch", "action", "responseId"],
  "synthesis.segment": ["atMs", "type", "epoch", "responseId", "segmentId", "segmentIndex", "durationMs"],
  playback: ["atMs", "type", "epoch", "action", "responseId", "segmentId"],
  interrupt: ["atMs", "type", "epoch", "responseId", "source"],
  transport: ["atMs", "type", "epoch", "action"],
  backpressure: ["atMs", "type", "epoch", "queuedAudioMs"],
  quota: ["atMs", "type", "epoch", "quota"],
  device: ["atMs", "type", "epoch", "action"],
  operation: ["atMs", "type", "epoch", "operationId", "runId", "label", "state"],
  end: ["atMs", "type", "epoch", "reason"],
};

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${location}.${key} is not a supported field`);
    }
  }
}

function validateAction(action: unknown, index: number, maxDurationMs: number): void {
  const field = (name: string) => `timeline[${index}].${name}`;
  if (!isRecord(action)) {
    throw new TypeError(`timeline[${index}] must be an object`);
  }
  requireNonNegativeSafeInteger(action.atMs, field("atMs"));
  if (action.atMs > maxDurationMs) {
    throw new RangeError(`timeline[${index}].atMs exceeds the scenario duration limit`);
  }
  if (typeof action.type !== "string") {
    throw new TypeError(field("type") + " must be a string");
  }
  switch (action.type) {
    case "permission":
      requireEnum(action.outcome, field("outcome"), ["granted", "denied", "revoked"]);
      break;
    case "capture":
      requireEnum(action.action, field("action"), ["start", "stop"]);
      requireIdentifier(action.turnId, field("turnId"));
      break;
    case "vad":
      requireEnum(action.action, field("action"), ["speech_start", "speech_end"]);
      requireIdentifier(action.turnId, field("turnId"));
      break;
    case "transcript.provisional":
      requireIdentifier(action.turnId, field("turnId"));
      requireNonNegativeSafeInteger(action.revision, field("revision"));
      requireTranscript(action.text, field("text"));
      break;
    case "transcript.final":
      requireIdentifier(action.turnId, field("turnId"));
      requireIdentifier(action.finalityId, field("finalityId"));
      requireNonNegativeSafeInteger(action.localOrder, field("localOrder"));
      requireTranscript(action.text, field("text"));
      break;
    case "generation":
      requireEnum(action.action, field("action"), ["start", "cancel", "complete"]);
      requireIdentifier(action.responseId, field("responseId"));
      break;
    case "synthesis.segment":
      requireIdentifier(action.responseId, field("responseId"));
      requireIdentifier(action.segmentId, field("segmentId"));
      requireBoundedNonNegative(
        action.segmentIndex,
        field("segmentIndex"),
        VOICE_SIMULATOR_LIMITS.maxSegments - 1,
      );
      requireBoundedNonNegative(
        action.durationMs,
        field("durationMs"),
        VOICE_SIMULATOR_LIMITS.maxDurationMs,
      );
      break;
    case "playback":
      requireEnum(action.action, field("action"), ["start", "segment_played", "stop"]);
      requireIdentifier(action.responseId, field("responseId"));
      if (action.segmentId !== undefined) requireIdentifier(action.segmentId, field("segmentId"));
      break;
    case "interrupt":
      requireIdentifier(action.responseId, field("responseId"));
      requireEnum(action.source, field("source"), ["user", "barge_in"]);
      break;
    case "transport":
      requireEnum(action.action, field("action"), ["disconnect", "reconnect"]);
      requirePositiveSafeInteger(action.epoch, field("epoch"));
      break;
    case "backpressure":
      requireBoundedNonNegative(
        action.queuedAudioMs,
        field("queuedAudioMs"),
        VOICE_SIMULATOR_LIMITS.maxQueuedAudioMs,
      );
      break;
    case "quota":
      requireEnum(action.quota, field("quota"), ["session", "usage"]);
      break;
    case "device":
      requireEnum(action.action, field("action"), ["input_lost", "output_lost", "restored"]);
      break;
    case "operation":
      requireIdentifier(action.operationId, field("operationId"));
      requireIdentifier(action.runId, field("runId"));
      requireLabel(action.label, field("label"));
      requireEnum(action.state, field("state"), CANONICAL_OPERATION_STATES);
      break;
    case "end":
      requireEnum(action.reason, field("reason"), ["user", "failure", "shutdown"]);
      break;
    default:
      throw new TypeError(`timeline[${index}].type is not a supported simulator action`);
  }
  rejectUnknownKeys(
    action,
    ACTION_FIELDS[action.type as string] ?? [],
    `timeline[${index}]`,
  );
  if (action.epoch !== undefined) {
    requirePositiveSafeInteger(action.epoch, field("epoch"));
  }
}

const SCENARIO_FIELDS = ["scenarioId", "version", "initialEpoch", "limits", "timeline"] as const;
const LIMIT_FIELDS = ["maxQueuedAudioMs", "maxDurationMs"] as const;

export function assertValidVoiceSimulatorScenario(
  scenario: unknown,
): asserts scenario is VoiceSimulatorScenario {
  if (!isRecord(scenario)) {
    throw new TypeError("scenario must be an object");
  }
  rejectUnknownKeys(scenario, SCENARIO_FIELDS, "scenario");
  requireIdentifier(scenario.scenarioId, "scenarioId");
  if (scenario.version !== 1) {
    throw new RangeError("scenario.version must be 1");
  }
  requirePositiveSafeInteger(scenario.initialEpoch, "initialEpoch");
  if (!isRecord(scenario.limits)) {
    throw new TypeError("scenario.limits must be an object");
  }
  rejectUnknownKeys(scenario.limits, LIMIT_FIELDS, "scenario.limits");
  const maxQueuedAudioMs = scenario.limits.maxQueuedAudioMs;
  const maxDurationMs = scenario.limits.maxDurationMs;
  requirePositiveSafeInteger(maxQueuedAudioMs, "limits.maxQueuedAudioMs");
  if (maxQueuedAudioMs > VOICE_SIMULATOR_LIMITS.maxQueuedAudioMs) {
    throw new RangeError(`limits.maxQueuedAudioMs exceeds ${VOICE_SIMULATOR_LIMITS.maxQueuedAudioMs}`);
  }
  requirePositiveSafeInteger(maxDurationMs, "limits.maxDurationMs");
  if (maxDurationMs > VOICE_SIMULATOR_LIMITS.maxDurationMs) {
    throw new RangeError(`limits.maxDurationMs exceeds ${VOICE_SIMULATOR_LIMITS.maxDurationMs}`);
  }
  if (!Array.isArray(scenario.timeline)) {
    throw new TypeError("scenario.timeline must be an array");
  }
  if (scenario.timeline.length > VOICE_SIMULATOR_LIMITS.maxTimelineActions) {
    throw new RangeError(`scenario.timeline exceeds ${VOICE_SIMULATOR_LIMITS.maxTimelineActions} actions`);
  }
  scenario.timeline.forEach((action, index) => validateAction(action, index, maxDurationMs));
}
