import { z } from "zod/v4";
import { IsoTimestampSchema } from "#contract-primitives";

export const SPEECH_CONTRACT_VERSION = 1 as const;
export const SPEECH_MAX_TRANSCRIPT_CHARS = 32_000;
export const SpeechRequestIdSchema = z.string()
  .min(33)
  .max(100)
  .regex(/^sp_[0-9]{13}_[A-Za-z0-9_-]{16,64}$/);
export const SpeechSourceKindSchema = z.enum(["dictation", "owner_audio"]);
export const SpeechMediaTypeSchema = z.enum(["audio/wav"]);
export const SpeechExecutionStateSchema = z.enum([
  "received",
  "reserved",
  "dispatching",
  "succeeded",
  "failed",
  "uncertain",
  "cancelled",
]);
export const SpeechOutcomeCodeSchema = z.enum([
  "transcript",
  "no_speech",
  "invalid_media",
  "timeout",
  "provider_failure",
  "cancelled",
]);

const SpeechEnabledSourcePolicySchema = z.object({
  enabled: z.literal(true),
  maxBytes: z.number().int().positive().max(64 * 1024 * 1024),
  maxDurationMs: z.number().int().positive().max(60 * 60_000),
  maxTranscriptChars: z.number().int().positive().max(SPEECH_MAX_TRANSCRIPT_CHARS),
  supportedMediaTypes: z.array(SpeechMediaTypeSchema).min(1).max(8),
  languageHints: z.boolean(),
}).strict();

const SpeechDictationPolicySchema = z.object({
  enabled: z.boolean(),
  maxBytes: z.number().int().positive().max(10 * 1024 * 1024),
  maxDurationMs: z.number().int().positive().max(120_000),
  maxTranscriptChars: z.number().int().positive().max(SPEECH_MAX_TRANSCRIPT_CHARS),
  supportedMediaTypes: z.array(SpeechMediaTypeSchema).min(1).max(8),
  languageHints: z.boolean(),
}).strict();

const SpeechDisabledSourcePolicySchema = z.object({ enabled: z.literal(false) }).strict();
const SpeechFileTranscriptionPolicySchema = z.object({
  status: z.literal("ready"),
  dictation: SpeechDictationPolicySchema.extend({ enabled: z.literal(true) }).strict(),
  ownerAudio: z.union([SpeechDisabledSourcePolicySchema, SpeechEnabledSourcePolicySchema]),
}).strict();
const SpeechFileTranscriptionUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.enum([
    "disabled",
    "misconfigured",
    "funding_unavailable",
    "media_validation_unavailable",
    "temporarily_unavailable",
  ]),
  dictation: SpeechDictationPolicySchema,
  ownerAudio: z.union([SpeechDisabledSourcePolicySchema, SpeechEnabledSourcePolicySchema]),
}).strict();

export const SpeechCapabilitiesResponseSchema = z.object({
  contractVersion: z.literal(SPEECH_CONTRACT_VERSION),
  fileTranscription: z.union([
    SpeechFileTranscriptionPolicySchema,
    SpeechFileTranscriptionUnavailableSchema,
  ]),
}).strict();

const TranscriptTextSchema = z.string().min(1).max(SPEECH_MAX_TRANSCRIPT_CHARS).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 128 * 1024,
  "Transcript exceeds byte limit",
);

export const SpeechTranscriptionResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    contractVersion: z.literal(SPEECH_CONTRACT_VERSION),
    requestId: SpeechRequestIdSchema,
    status: z.literal("succeeded"),
    outcome: z.literal("transcript"),
    text: TranscriptTextSchema,
    audioDurationMs: z.number().int().positive().max(60 * 60_000),
  }).strict(),
  z.object({
    contractVersion: z.literal(SPEECH_CONTRACT_VERSION),
    requestId: SpeechRequestIdSchema,
    status: z.literal("succeeded"),
    outcome: z.literal("no_speech"),
    audioDurationMs: z.number().int().positive().max(60 * 60_000),
  }).strict(),
]);

const SpeechStatusBaseShape = {
  contractVersion: z.literal(SPEECH_CONTRACT_VERSION),
  requestId: SpeechRequestIdSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
};

export const SpeechStatusResponseSchema = z.discriminatedUnion("executionState", [
  z.object({
    ...SpeechStatusBaseShape,
    executionState: z.literal("received"),
    cancellationRequested: z.literal(false),
    executionStarted: z.literal(false),
    retrySafety: z.literal("same_request_safe_before_dispatch"),
    outcomeCode: z.null(),
  }).strict(),
  z.object({
    ...SpeechStatusBaseShape,
    executionState: z.literal("reserved"),
    cancellationRequested: z.literal(false),
    executionStarted: z.literal(false),
    retrySafety: z.literal("same_request_safe_before_dispatch"),
    outcomeCode: z.null(),
  }).strict(),
  z.object({
    ...SpeechStatusBaseShape,
    executionState: z.literal("dispatching"),
    cancellationRequested: z.boolean(),
    executionStarted: z.literal(true),
    retrySafety: z.literal("new_request_may_consume_allowance"),
    outcomeCode: z.null(),
  }).strict(),
  z.object({
    ...SpeechStatusBaseShape,
    executionState: z.literal("succeeded"),
    cancellationRequested: z.boolean(),
    executionStarted: z.literal(true),
    retrySafety: z.literal("terminal_no_retry_needed"),
    outcomeCode: z.enum(["transcript", "no_speech"]),
  }).strict(),
  z.object({
    ...SpeechStatusBaseShape,
    executionState: z.literal("failed"),
    cancellationRequested: z.boolean(),
    executionStarted: z.literal(true),
    retrySafety: z.literal("new_request_may_consume_allowance"),
    outcomeCode: z.enum(["invalid_media", "timeout", "provider_failure"]),
  }).strict(),
  z.object({
    ...SpeechStatusBaseShape,
    executionState: z.literal("uncertain"),
    cancellationRequested: z.boolean(),
    executionStarted: z.literal(true),
    retrySafety: z.literal("new_request_may_consume_allowance"),
    outcomeCode: z.enum(["timeout", "provider_failure", "cancelled"]),
  }).strict(),
  z.object({
    ...SpeechStatusBaseShape,
    executionState: z.literal("cancelled"),
    cancellationRequested: z.literal(true),
    executionStarted: z.literal(false),
    retrySafety: z.literal("terminal_no_retry_needed"),
    outcomeCode: z.literal("cancelled"),
  }).strict(),
]).superRefine((status, context) => {
  if (status.executionState === "uncertain"
    && status.outcomeCode === "cancelled"
    && !status.cancellationRequested) {
    context.addIssue({
      code: "custom",
      message: "A cancelled uncertain outcome requires cancellation intent",
      path: ["cancellationRequested"],
    });
  }
});

const SpeechCancellationBaseShape = {
  contractVersion: z.literal(SPEECH_CONTRACT_VERSION),
  requestId: SpeechRequestIdSchema,
  cancellationRequested: z.literal(true),
};

export const SpeechCancellationResponseSchema = z.discriminatedUnion("executionState", [
  z.object({
    ...SpeechCancellationBaseShape,
    executionState: z.literal("cancelled"),
    executionStarted: z.literal(false),
  }).strict(),
  ...(["dispatching", "succeeded", "failed", "uncertain"] as const).map((executionState) => z.object({
    ...SpeechCancellationBaseShape,
    executionState: z.literal(executionState),
    executionStarted: z.literal(true),
  }).strict()),
]);

export const SpeechSafeErrorResponseSchema = z.object({
  error: z.discriminatedUnion("code", [
    z.object({ code: z.literal("unauthorized"), message: z.literal("Unauthorized") }).strict(),
    z.object({ code: z.literal("unavailable"), message: z.literal("Speech is unavailable") }).strict(),
    z.object({ code: z.literal("invalid_request"), message: z.literal("Invalid speech request") }).strict(),
    z.object({ code: z.literal("invalid_media"), message: z.literal("This recording cannot be transcribed") }).strict(),
    z.object({ code: z.literal("request_conflict"), message: z.literal("This speech request was already used") }).strict(),
    z.object({ code: z.literal("not_found"), message: z.literal("Speech request not found") }).strict(),
    z.object({ code: z.literal("rate_limited"), message: z.literal("Try speech again later") }).strict(),
    z.object({ code: z.literal("allowance_exhausted"), message: z.literal("Speech allowance is unavailable") }).strict(),
    z.object({ code: z.literal("timeout"), message: z.literal("Transcription timed out") }).strict(),
    z.object({ code: z.literal("transcription_failed"), message: z.literal("Transcription failed") }).strict(),
    z.object({ code: z.literal("cancelled"), message: z.literal("Transcription was cancelled") }).strict(),
  ]),
}).strict();

export type SpeechCapabilitiesResponse = z.infer<typeof SpeechCapabilitiesResponseSchema>;
export type SpeechTranscriptionResponse = z.infer<typeof SpeechTranscriptionResponseSchema>;
export type SpeechStatusResponse = z.infer<typeof SpeechStatusResponseSchema>;
export type SpeechCancellationResponse = z.infer<typeof SpeechCancellationResponseSchema>;
export type SpeechExecutionState = z.infer<typeof SpeechExecutionStateSchema>;
export type SpeechOutcomeCode = z.infer<typeof SpeechOutcomeCodeSchema>;
export type SpeechSourceKind = z.infer<typeof SpeechSourceKindSchema>;
export type SpeechMediaType = z.infer<typeof SpeechMediaTypeSchema>;
