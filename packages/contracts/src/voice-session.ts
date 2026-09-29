import { z } from "zod/v4";

export const VOICE_SESSION_CONTRACT_VERSION = 1 as const;
export const VOICE_SESSION_LIMITS = {
  maxSequence: Number.MAX_SAFE_INTEGER,
  maxTranscriptChars: 8_000,
  maxTranscriptBytes: 32_000,
  maxAudioFrameBytes: 64 * 1024,
  maxQueuedAudioMs: 10_000,
  maxSessionSeconds: 3_600,
  maxIdleSeconds: 300,
  maxReconnectAttempts: 8,
  maxSegments: 512,
  maxOperationLabelChars: 120,
} as const;

const SAFE_ID_BODY = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const textEncoder = new TextEncoder();

function prefixedId(prefix: string) {
  return z.string()
    .min(prefix.length + 1)
    .max(prefix.length + 128)
    .startsWith(prefix)
    .refine((value) => SAFE_ID_BODY.test(value.slice(prefix.length)), "Invalid identifier");
}

function boundedText(maxChars: number, maxBytes: number) {
  return z.string()
    .min(1)
    .refine((value) => [...value].length <= maxChars, "Text exceeds character limit")
    .refine((value) => value.trim().length > 0, "Text cannot be blank")
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes, "Text exceeds byte limit");
}

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export const VoiceSessionStateSchema = z.enum([
  "requesting_permission",
  "connecting",
  "listening",
  "thinking",
  "using_tool",
  "speaking",
  "paused",
  "reconnecting",
  "restoring",
  "failed",
  "ending",
  "ended",
]);
export const VoiceVisibleStateSchema = z.enum([
  "connecting",
  "listening",
  "thinking",
  "using_tool",
  "speaking",
  "paused",
  "reconnecting",
  "failed",
  "ended",
]);

export const VoiceTurnModeSchema = z.enum(["hands_free", "push_to_talk"]);
export const VoiceSessionIdSchema = prefixedId("vs_");
export const VoiceTurnIdSchema = prefixedId("vturn_");
export const VoiceResponseIdSchema = prefixedId("vresp_");
export const VoiceSegmentIdSchema = prefixedId("vseg_");
export const VoiceFinalityIdSchema = prefixedId("vfinal_");
export const VoiceActionIdSchema = prefixedId("action_");
export const VoiceCanonicalChatIdSchema = prefixedId("chat_");
export const VoiceCanonicalTurnIdSchema = prefixedId("cturn_");
export const VoiceCanonicalRunIdSchema = prefixedId("run_");
export const VoiceEpochSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const VoiceSequenceSchema = z.number().int().nonnegative().max(VOICE_SESSION_LIMITS.maxSequence);
export const VoiceRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const VoiceDurationMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const VoiceTimestampMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const VoiceTranscriptTextSchema = boundedText(
  VOICE_SESSION_LIMITS.maxTranscriptChars,
  VOICE_SESSION_LIMITS.maxTranscriptBytes,
);
export const VoiceAudioFrameDataSchema = z.string()
  .min(4)
  .max(Math.ceil(VOICE_SESSION_LIMITS.maxAudioFrameBytes / 3) * 4)
  .regex(BASE64, "Malformed base64 audio")
  .refine(
    (value) => decodedBase64Bytes(value) <= VOICE_SESSION_LIMITS.maxAudioFrameBytes,
    "Audio frame exceeds decoded byte limit",
  );

export const VoiceSessionLimitsSchema = z.object({
  maxSequence: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxSequence),
  maxTranscriptChars: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxTranscriptChars),
  maxTranscriptBytes: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxTranscriptBytes),
  maxAudioFrameBytes: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxAudioFrameBytes),
  maxQueuedAudioMs: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxQueuedAudioMs),
  maxSessionSeconds: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxSessionSeconds),
  maxIdleSeconds: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxIdleSeconds),
  maxReconnectAttempts: z.number().int().nonnegative().max(VOICE_SESSION_LIMITS.maxReconnectAttempts),
  maxSegments: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxSegments),
  maxOperationLabelChars: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxOperationLabelChars),
}).strict();

export const VoiceCapabilityLimitsSchema = z.object({
  maxSessionSeconds: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxSessionSeconds),
  maxIdleSeconds: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxIdleSeconds),
}).strict();

export const VoiceCapabilitySchema = z.object({
  contractVersion: z.literal(VOICE_SESSION_CONTRACT_VERSION),
  status: z.enum(["available", "degraded", "unavailable"]),
  surface: z.enum(["web_canvas", "web_desktop", "electron_desktop", "native_mobile"]),
  transportModes: z.array(z.enum(["relayed_websocket", "direct_webrtc"])).max(2),
  turnModes: z.array(VoiceTurnModeSchema).max(2),
  supportsInterruption: z.boolean(),
  resume: z.enum(["delivery_aware", "rebuild_only", "unsupported"]),
  sessionOnly: z.enum(["enforced", "unsupported"]),
  actionMode: z.enum(["conversation_only", "safe_reads", "canonical_actions"]),
  actionCancellation: z.enum(["none", "run", "tool"]),
  supportsInputSelection: z.boolean(),
  supportsOutputSelection: z.boolean(),
  limits: VoiceCapabilityLimitsSchema.optional(),
  reason: z.enum([
    "not_configured",
    "policy_disabled",
    "surface_unsupported",
    "provider_unavailable",
    "limit_reached",
  ]).optional(),
}).strict();

export const AudioFormatSchema = z.object({
  codec: z.enum(["pcm_s16le", "pcm_f32le", "opus"]),
  sampleRateHz: z.union([
    z.literal(8_000),
    z.literal(16_000),
    z.literal(24_000),
    z.literal(32_000),
    z.literal(44_100),
    z.literal(48_000),
  ]),
  channels: z.union([z.literal(1), z.literal(2)]),
  frameDurationMs: z.number().int().min(5).max(120),
}).strict();

export const ClientMediaCapabilitiesSchema = z.object({
  formats: z.array(AudioFormatSchema).min(1).max(8),
  binaryAudio: z.boolean(),
  maxAudioFrameBytes: z.number().int().positive().max(VOICE_SESSION_LIMITS.maxAudioFrameBytes),
  deviceChangeEvents: z.boolean(),
}).strict();

export const VoicePlaybackAckSchema = z.object({
  responseId: VoiceResponseIdSchema,
  segmentId: VoiceSegmentIdSchema,
  deliveryRevision: VoiceRevisionSchema,
  playedThroughMs: VoiceDurationMsSchema,
}).strict();

export const VoiceSessionControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.pause") }).strict(),
  z.object({ type: z.literal("session.resume") }).strict(),
  z.object({
    type: z.literal("session.end"),
    reason: z.enum(["user", "surface_closed", "sign_out"]),
  }).strict(),
  z.object({
    type: z.literal("response.interrupt"),
    responseId: VoiceResponseIdSchema,
    playedThroughMs: VoiceDurationMsSchema,
  }).strict(),
  z.object({
    type: z.literal("generation.cancel"),
    responseId: VoiceResponseIdSchema,
  }).strict(),
  z.object({
    type: z.literal("action.cancel"),
    actionId: VoiceActionIdSchema,
  }).strict(),
  z.object({ type: z.literal("playback.segment_played"), ...VoicePlaybackAckSchema.shape }).strict(),
  z.object({
    type: z.literal("device.changed"),
    inputDeviceId: z.string().min(1).max(256).regex(SAFE_ID_BODY).optional(),
    outputDeviceId: z.string().min(1).max(256).regex(SAFE_ID_BODY).optional(),
  }).strict(),
  z.object({ type: z.literal("heartbeat"), timestampMs: VoiceTimestampMsSchema }).strict(),
]);

export const VoiceTranscriptProvisionalSchema = z.object({
  turnId: VoiceTurnIdSchema,
  revision: VoiceRevisionSchema,
  text: VoiceTranscriptTextSchema,
}).strict();
export const VoiceTranscriptFinalSchema = z.object({
  turnId: VoiceTurnIdSchema,
  finalityId: VoiceFinalityIdSchema,
  canonicalTurnId: VoiceCanonicalTurnIdSchema,
  localOrder: VoiceSequenceSchema,
  text: VoiceTranscriptTextSchema,
}).strict();
export const VoiceTranscriptCorrectionSchema = z.object({
  turnId: VoiceTurnIdSchema,
  finalityId: VoiceFinalityIdSchema,
  revision: VoiceRevisionSchema,
  text: VoiceTranscriptTextSchema,
}).strict();

export const VoiceResponseSegmentSchema = z.object({
  segmentId: VoiceSegmentIdSchema,
  segmentIndex: z.number().int().nonnegative().max(VOICE_SESSION_LIMITS.maxSegments - 1),
  textStart: z.number().int().nonnegative().max(VOICE_SESSION_LIMITS.maxTranscriptChars),
  textEnd: z.number().int().nonnegative().max(VOICE_SESSION_LIMITS.maxTranscriptChars),
  durationMs: VoiceDurationMsSchema,
}).strict().refine((segment) => segment.textEnd >= segment.textStart, {
  message: "Segment text end precedes start",
  path: ["textEnd"],
});
export const VoiceResponseSchema = z.object({
  responseId: VoiceResponseIdSchema,
  runId: VoiceCanonicalRunIdSchema,
  segments: z.array(VoiceResponseSegmentSchema).max(VOICE_SESSION_LIMITS.maxSegments),
}).strict();

export const SafeVoiceErrorCodeSchema = z.enum([
  "permission_denied",
  "input_unavailable",
  "output_unavailable",
  "connection_failed",
  "connection_lost",
  "provider_unavailable",
  "session_limit_reached",
  "usage_limit_reached",
  "audio_backpressure",
  "chat_unavailable",
  "session_conflict",
  "unsupported_surface",
  "internal_failure",
]);
export const VoiceRecoveryActionSchema = z.enum([
  "request_permission",
  "choose_input",
  "choose_output",
  "retry_connection",
  "continue_in_chat",
  "start_new_session",
  "contact_support",
  "none",
]);
export const SafeVoiceErrorSchema = z.object({
  code: SafeVoiceErrorCodeSchema,
  retryable: z.boolean(),
  recovery: VoiceRecoveryActionSchema,
}).strict();

export const CanonicalOperationStateSchema = z.enum([
  "queued",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "outcome_unknown",
]);
export const VoiceSessionStateReasonSchema = z.enum([
  "user_requested",
  "permission_revoked",
  "input_lost",
  "output_lost",
  "transport_lost",
  "restored",
  "limit_reached",
  "shutdown",
]);

export const VoiceFrameCommonSchema = z.object({
  contractVersion: z.literal(VOICE_SESSION_CONTRACT_VERSION),
  sessionId: VoiceSessionIdSchema,
  epoch: VoiceEpochSchema,
  sequence: VoiceSequenceSchema,
}).strict();
const commonFrameShape = VoiceFrameCommonSchema.shape;

export const VoiceClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ ...commonFrameShape, type: z.literal("client.ready"), audio: AudioFormatSchema, capabilities: ClientMediaCapabilitiesSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("capture.start"), turnId: VoiceTurnIdSchema, mode: VoiceTurnModeSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("capture.stop"), turnId: VoiceTurnIdSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("capture.audio"), turnId: VoiceTurnIdSchema, timestampMs: VoiceTimestampMsSchema, data: VoiceAudioFrameDataSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("session.pause") }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("session.resume") }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("session.end"), reason: z.enum(["user", "surface_closed", "sign_out"]) }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("response.interrupt"), responseId: VoiceResponseIdSchema, playedThroughMs: VoiceDurationMsSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("generation.cancel"), responseId: VoiceResponseIdSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("action.cancel"), actionId: VoiceActionIdSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("playback.segment_played"), ...VoicePlaybackAckSchema.shape }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("device.changed"), inputDeviceId: z.string().min(1).max(256).regex(SAFE_ID_BODY).optional(), outputDeviceId: z.string().min(1).max(256).regex(SAFE_ID_BODY).optional() }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("heartbeat"), timestampMs: VoiceTimestampMsSchema }).strict(),
]);

export const VoiceServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ ...commonFrameShape, type: z.literal("session.state"), state: VoiceSessionStateSchema, reason: VoiceSessionStateReasonSchema.optional() }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("session.resumed"), state: VoiceSessionStateSchema, reason: VoiceSessionStateReasonSchema.optional() }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("transcript.provisional"), ...VoiceTranscriptProvisionalSchema.shape }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("transcript.final"), ...VoiceTranscriptFinalSchema.shape }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("transcript.correction"), ...VoiceTranscriptCorrectionSchema.shape }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("response.started"), responseId: VoiceResponseIdSchema, runId: VoiceCanonicalRunIdSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("response.audio"), responseId: VoiceResponseIdSchema, segmentId: VoiceSegmentIdSchema, startMs: VoiceDurationMsSchema, data: VoiceAudioFrameDataSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("response.audio_end"), responseId: VoiceResponseIdSchema, generatedDurationMs: VoiceDurationMsSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("response.interrupted"), responseId: VoiceResponseIdSchema, effectiveThroughMs: VoiceDurationMsSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("operation.status"), runId: VoiceCanonicalRunIdSchema, label: boundedText(VOICE_SESSION_LIMITS.maxOperationLabelChars, VOICE_SESSION_LIMITS.maxOperationLabelChars * 4), state: CanonicalOperationStateSchema }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("transport.going_away"), retryAfterMs: z.number().int().nonnegative().max(60_000), reconnectAllowed: z.boolean() }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("session.error"), ...SafeVoiceErrorSchema.shape }).strict(),
  z.object({ ...commonFrameShape, type: z.literal("heartbeat.ack"), timestampMs: VoiceTimestampMsSchema }).strict(),
]);

export type VoiceTurnMode = z.infer<typeof VoiceTurnModeSchema>;
export type VoiceSessionState = z.infer<typeof VoiceSessionStateSchema>;
export type VoiceVisibleState = z.infer<typeof VoiceVisibleStateSchema>;
export type VoiceSessionId = z.infer<typeof VoiceSessionIdSchema>;
export type VoiceTurnId = z.infer<typeof VoiceTurnIdSchema>;
export type VoiceResponseId = z.infer<typeof VoiceResponseIdSchema>;
export type VoiceSegmentId = z.infer<typeof VoiceSegmentIdSchema>;
export type VoiceFinalityId = z.infer<typeof VoiceFinalityIdSchema>;
export type VoiceActionId = z.infer<typeof VoiceActionIdSchema>;
export type VoiceCanonicalChatId = z.infer<typeof VoiceCanonicalChatIdSchema>;
export type VoiceCanonicalTurnId = z.infer<typeof VoiceCanonicalTurnIdSchema>;
export type VoiceCanonicalRunId = z.infer<typeof VoiceCanonicalRunIdSchema>;
export type VoiceEpoch = z.infer<typeof VoiceEpochSchema>;
export type VoiceSequence = z.infer<typeof VoiceSequenceSchema>;
export type VoiceRevision = z.infer<typeof VoiceRevisionSchema>;
export type VoiceDurationMs = z.infer<typeof VoiceDurationMsSchema>;
export type VoiceTimestampMs = z.infer<typeof VoiceTimestampMsSchema>;
export type VoiceTranscriptText = z.infer<typeof VoiceTranscriptTextSchema>;
export type VoiceAudioFrameData = z.infer<typeof VoiceAudioFrameDataSchema>;
export type VoiceSessionLimits = z.infer<typeof VoiceSessionLimitsSchema>;
export type VoiceCapabilityLimits = z.infer<typeof VoiceCapabilityLimitsSchema>;
export type VoiceCapability = z.infer<typeof VoiceCapabilitySchema>;
export type AudioFormat = z.infer<typeof AudioFormatSchema>;
export type ClientMediaCapabilities = z.infer<typeof ClientMediaCapabilitiesSchema>;
export type VoicePlaybackAck = z.infer<typeof VoicePlaybackAckSchema>;
export type VoiceSessionControl = z.infer<typeof VoiceSessionControlSchema>;
export type VoiceTranscriptProvisional = z.infer<typeof VoiceTranscriptProvisionalSchema>;
export type VoiceTranscriptFinal = z.infer<typeof VoiceTranscriptFinalSchema>;
export type VoiceTranscriptCorrection = z.infer<typeof VoiceTranscriptCorrectionSchema>;
export type VoiceResponseSegment = z.infer<typeof VoiceResponseSegmentSchema>;
export type VoiceResponse = z.infer<typeof VoiceResponseSchema>;
export type SafeVoiceErrorCode = z.infer<typeof SafeVoiceErrorCodeSchema>;
export type VoiceRecoveryAction = z.infer<typeof VoiceRecoveryActionSchema>;
export type SafeVoiceError = z.infer<typeof SafeVoiceErrorSchema>;
export type CanonicalOperationState = z.infer<typeof CanonicalOperationStateSchema>;
export type VoiceSessionStateReason = z.infer<typeof VoiceSessionStateReasonSchema>;
export type VoiceFrameCommon = z.infer<typeof VoiceFrameCommonSchema>;
export type VoiceClientFrame = z.infer<typeof VoiceClientFrameSchema>;
export type VoiceServerFrame = z.infer<typeof VoiceServerFrameSchema>;
