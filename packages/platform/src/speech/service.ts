import { createHmac } from "node:crypto";
import type { Transaction } from "kysely";
import {
  SPEECH_CONTRACT_VERSION,
  SPEECH_MAX_TRANSCRIPT_CHARS,
  SpeechCancellationResponseSchema,
  SpeechLanguageHintsSchema,
  SpeechMediaTypeSchema,
  SpeechRequestIdSchema,
  SpeechSourceKindSchema,
  SpeechStatusResponseSchema,
  type SpeechCapabilitiesResponse,
  type SpeechCancellationResponse,
  type SpeechStatusResponse,
  type SpeechTranscriptionResponse,
} from "@matrix-os/contracts";
import type { PlatformDatabase } from "../db.js";
import { SpeechAdapterError, type FileTranscriptionAdapter } from "./adapters/openai.js";
import { inspectSpeechWav, SpeechMediaError } from "./media.js";
import { SpeechFundingError } from "./funding.js";
import {
  SpeechOperationConflictError,
  SpeechOperationRateLimitError,
  type SpeechOperationIdentity,
  type SpeechOperationRecord,
  type SpeechOperationsRepository,
} from "./operations.js";

const MAX_ACTIVE_TRANSCRIPTIONS = 4;
const MAX_MICROUSD_PER_MINUTE = 1_000_000_000;

export type SpeechServiceErrorCode =
  | "unavailable"
  | "invalid_request"
  | "invalid_media"
  | "request_conflict"
  | "rate_limited"
  | "allowance_exhausted"
  | "timeout"
  | "transcription_failed"
  | "cancelled"
  | "result_not_replayable";

export class SpeechServiceError extends Error {
  constructor(readonly code: SpeechServiceErrorCode) {
    super("Speech request failed safely");
    this.name = "SpeechServiceError";
  }
}

export interface SpeechFundingPort {
  reserve(
    trx: Transaction<PlatformDatabase>,
    input: {
      identity: SpeechOperationIdentity;
      requestId: string;
      policyRevision: string;
      modelId: string;
      maximumCostMicrousd: number;
    },
  ): Promise<{ reservationId: string; reservedMicrousd: number }>;
  start(trx: Transaction<PlatformDatabase>, reservationId: string): Promise<void>;
  settle(
    trx: Transaction<PlatformDatabase>,
    reservationId: string,
    input: { mode: "exact"; actualCostMicrousd: number } | { mode: "conservative" },
  ): Promise<void>;
  release(trx: Transaction<PlatformDatabase>, reservationId: string): Promise<void>;
}

interface EnabledSourcePolicy {
  enabled: true;
  maxBytes: number;
  maxDurationMs: number;
  maxTranscriptChars: number;
  supportedMediaTypes: readonly ["audio/wav", ..."audio/wav"[]];
  languageHints: boolean;
}

interface DisabledSourcePolicy {
  enabled: false;
}

export interface PlatformSpeechPolicy {
  enabled: boolean;
  revision: string;
  modelId: string;
  microusdPerMinute: number;
  dictation: EnabledSourcePolicy;
  ownerAudio: EnabledSourcePolicy | DisabledSourcePolicy;
}

export interface SpeechTranscriptionInput {
  identity: SpeechOperationIdentity;
  requestId: string;
  sourceKind: "dictation" | "owner_audio";
  audio: Uint8Array;
  mediaType: "audio/wav";
  languageHints?: readonly string[];
  signal: AbortSignal;
}

export interface PlatformSpeechService {
  capabilities(): SpeechCapabilitiesResponse;
  transcribe(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResponse>;
  status(identity: SpeechOperationIdentity, requestId: string): Promise<SpeechStatusResponse | undefined>;
  cancel(identity: SpeechOperationIdentity, requestId: string): Promise<SpeechCancellationResponse>;
  shutdown(): Promise<void>;
}

function safeInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Speech ${name} is invalid`);
  }
}

function validatePolicy(policy: PlatformSpeechPolicy): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(policy.revision)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(policy.modelId)) {
    throw new Error("Speech policy identifiers are invalid");
  }
  safeInteger(policy.microusdPerMinute, 0, MAX_MICROUSD_PER_MINUTE, "price policy");
  for (const source of [policy.dictation, policy.ownerAudio]) {
    if (!source.enabled) continue;
    safeInteger(source.maxBytes, 44, 64 * 1024 * 1024, "byte limit");
    safeInteger(source.maxDurationMs, 1, 60 * 60_000, "duration limit");
    safeInteger(source.maxTranscriptChars, 1, SPEECH_MAX_TRANSCRIPT_CHARS, "transcript limit");
    if (source.supportedMediaTypes.length < 1 || source.supportedMediaTypes.length > 8
      || source.supportedMediaTypes.some((mediaType) => mediaType !== "audio/wav")) {
      throw new Error("Speech media policy is invalid");
    }
  }
}

function operationStatus(operation: SpeechOperationRecord): SpeechStatusResponse {
  const retrySafety = operation.executionStarted
    ? operation.executionState === "succeeded"
      ? "terminal_no_retry_needed"
      : "new_request_may_consume_allowance"
    : operation.executionState === "cancelled"
      ? "terminal_no_retry_needed"
      : "same_request_safe_before_dispatch";
  return SpeechStatusResponseSchema.parse({
    contractVersion: SPEECH_CONTRACT_VERSION,
    requestId: operation.requestId,
    executionState: operation.executionState,
    cancellationRequested: operation.cancellationRequested,
    executionStarted: operation.executionStarted,
    retrySafety,
    outcomeCode: operation.outcomeCode,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  });
}

function cancellation(operation: SpeechOperationRecord): SpeechCancellationResponse {
  return SpeechCancellationResponseSchema.parse({
    contractVersion: SPEECH_CONTRACT_VERSION,
    requestId: operation.requestId,
    executionState: operation.executionState,
    cancellationRequested: true,
    executionStarted: operation.executionStarted,
  });
}

function microusdForDuration(durationMs: number, microusdPerMinute: number): number {
  const result = Math.ceil((durationMs * microusdPerMinute) / 60_000);
  if (!Number.isSafeInteger(result)) throw new Error("Speech price calculation overflowed");
  return result;
}

function contentFingerprint(
  secret: string,
  input: Pick<SpeechTranscriptionInput, "audio" | "mediaType" | "sourceKind">,
  policyRevision: string,
  languageHints: readonly string[],
): string {
  const hash = createHmac("sha256", secret);
  hash.update(`${input.sourceKind}\0${input.mediaType}\0${policyRevision}\0${JSON.stringify(languageHints)}\0`, "utf8");
  hash.update(input.audio);
  return hash.digest("hex");
}

function sourcePolicy(policy: PlatformSpeechPolicy, sourceKind: "dictation" | "owner_audio") {
  return sourceKind === "dictation" ? policy.dictation : policy.ownerAudio;
}

export function createPlatformSpeechService(options: {
  operations: SpeechOperationsRepository;
  funding: SpeechFundingPort;
  adapter: FileTranscriptionAdapter;
  fingerprintSecret: string;
  policy: PlatformSpeechPolicy;
  shutdownDrainTimeoutMs?: number;
}): PlatformSpeechService {
  validatePolicy(options.policy);
  if (new TextEncoder().encode(options.fingerprintSecret).byteLength < 32) {
    throw new Error("Speech fingerprint secret is too short");
  }
  const shutdownDrainTimeoutMs = options.shutdownDrainTimeoutMs ?? 8_000;
  safeInteger(shutdownDrainTimeoutMs, 1, 10_000, "shutdown drain timeout");
  const active = new Map<string, AbortController[]>();
  const activeTasks = new Set<Promise<void>>();
  const shutdownController = new AbortController();
  let activeSlots = 0;
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  function capabilities(): SpeechCapabilitiesResponse {
    const dictation = { ...options.policy.dictation, supportedMediaTypes: [...options.policy.dictation.supportedMediaTypes] };
    const ownerAudio = options.policy.ownerAudio.enabled
      ? { ...options.policy.ownerAudio, supportedMediaTypes: [...options.policy.ownerAudio.supportedMediaTypes] }
      : options.policy.ownerAudio;
    if (options.policy.enabled) {
      return { contractVersion: SPEECH_CONTRACT_VERSION, fileTranscription: { status: "ready", dictation, ownerAudio } };
    }
    return {
      contractVersion: SPEECH_CONTRACT_VERSION,
      fileTranscription: { status: "unavailable", reason: "disabled", dictation, ownerAudio },
    };
  }

  async function transcribe(input: SpeechTranscriptionInput): Promise<SpeechTranscriptionResponse> {
    if (shuttingDown || !options.policy.enabled) throw new SpeechServiceError("unavailable");
    if (input.signal.aborted || shutdownController.signal.aborted) throw new SpeechServiceError("cancelled");
    const parsedRequestId = SpeechRequestIdSchema.safeParse(input.requestId);
    const parsedSource = SpeechSourceKindSchema.safeParse(input.sourceKind);
    const parsedMediaType = SpeechMediaTypeSchema.safeParse(input.mediaType);
    if (!parsedRequestId.success || !parsedSource.success || !parsedMediaType.success) {
      throw new SpeechServiceError("invalid_request");
    }
    const selectedPolicy = sourcePolicy(options.policy, parsedSource.data);
    if (!selectedPolicy.enabled) throw new SpeechServiceError("unavailable");
    if (!selectedPolicy.supportedMediaTypes.includes(parsedMediaType.data)) {
      throw new SpeechServiceError("invalid_media");
    }
    const parsedLanguageHints = SpeechLanguageHintsSchema.safeParse(input.languageHints ?? []);
    if (!parsedLanguageHints.success) throw new SpeechServiceError("invalid_request");
    if (parsedLanguageHints.data.length > 0 && !selectedPolicy.languageHints) {
      throw new SpeechServiceError("invalid_request");
    }
    let durationMs: number;
    try {
      durationMs = inspectSpeechWav(input.audio, selectedPolicy).durationMs;
    } catch (error: unknown) {
      if (error instanceof SpeechMediaError) throw new SpeechServiceError("invalid_media");
      throw error;
    }
    if (activeSlots >= MAX_ACTIVE_TRANSCRIPTIONS) throw new SpeechServiceError("rate_limited");
    activeSlots += 1;
    const maximumCostMicrousd = microusdForDuration(selectedPolicy.maxDurationMs, options.policy.microusdPerMinute);
    const actualCostMicrousd = microusdForDuration(durationMs, options.policy.microusdPerMinute);
    const fingerprint = contentFingerprint(
      options.fingerprintSecret,
      input,
      options.policy.revision,
      parsedLanguageHints.data,
    );
    const operationKey = `${input.identity.ownerId}\0${input.identity.machineId}\0${input.identity.runtimeSlot}\0${input.requestId}`;
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal, shutdownController.signal]);
    const operationControllers = active.get(operationKey) ?? [];
    operationControllers.push(controller);
    active.set(operationKey, operationControllers);
    const taskCompletion = Promise.withResolvers<void>();
    activeTasks.add(taskCompletion.promise);
    try {
      let admitted: SpeechOperationRecord;
      try {
        admitted = await options.operations.admit({
          identity: input.identity,
          requestId: parsedRequestId.data,
          sourceKind: parsedSource.data,
          contentFingerprint: fingerprint,
          policyRevision: options.policy.revision,
          adapterId: options.adapter.id,
          modelId: options.policy.modelId,
          audioDurationMs: durationMs,
          maximumCostMicrousd,
        }, (trx) => options.funding.reserve(trx, {
          identity: input.identity,
          requestId: parsedRequestId.data,
          policyRevision: options.policy.revision,
          modelId: options.policy.modelId,
          maximumCostMicrousd,
        }));
      } catch (error: unknown) {
        if (error instanceof SpeechOperationConflictError) throw new SpeechServiceError("request_conflict");
        if (error instanceof SpeechOperationRateLimitError) throw new SpeechServiceError("rate_limited");
        if (error instanceof SpeechFundingError) throw new SpeechServiceError(error.code);
        throw error;
      }
      if (admitted.cancellationRequested) throw new SpeechServiceError("cancelled");
      if (signal.aborted) {
        await options.operations.cancel(input.identity, parsedRequestId.data, (trx, reservationId) => (
          options.funding.release(trx, reservationId)
        ));
        throw new SpeechServiceError("cancelled");
      }
      let cancellationAttempt: Promise<void> | undefined;
      let cancellationFailure: { error: unknown } | undefined;
      const requestCancellation = () => {
        cancellationAttempt ??= options.operations.cancel(
          input.identity,
          parsedRequestId.data,
          (trx, reservationId) => options.funding.release(trx, reservationId),
        ).then(
          () => undefined,
          (error: unknown) => { cancellationFailure = { error }; },
        );
      };
      const persistCancellationIfAborted = async (signal: AbortSignal): Promise<boolean> => {
        if (!signal.aborted) return false;
        requestCancellation();
        const attempt = cancellationAttempt;
        if (attempt) await attempt;
        if (cancellationFailure) throw cancellationFailure.error;
        return true;
      };
      signal.addEventListener("abort", requestCancellation, { once: true });
      try {
        const claim = await options.operations.claimDispatch(
          input.identity,
          parsedRequestId.data,
          (trx, reservationId) => options.funding.start(trx, reservationId),
        );
        const cancelledAfterClaim = await persistCancellationIfAborted(signal);
        if (!claim.claimed) {
          if (cancelledAfterClaim || claim.operation.cancellationRequested) {
            throw new SpeechServiceError("cancelled");
          }
          throw new SpeechServiceError("result_not_replayable");
        }
        try {
          const beforeDispatch = await options.operations.get(input.identity, parsedRequestId.data);
          if (!beforeDispatch || beforeDispatch.cancellationRequested
            || await persistCancellationIfAborted(signal)) {
            controller.abort();
            throw new SpeechServiceError("cancelled");
          }
          const result = await options.adapter.transcribe({
            audio: input.audio,
            mediaType: parsedMediaType.data,
            languageHints: parsedLanguageHints.data.length > 0 ? parsedLanguageHints.data : undefined,
            signal,
          });
          if (await persistCancellationIfAborted(signal)) throw new SpeechServiceError("cancelled");
          const text = result.text.trim();
          if (text.length > selectedPolicy.maxTranscriptChars
            || new TextEncoder().encode(text).byteLength > 128 * 1024) {
            throw new SpeechServiceError("transcription_failed");
          }
          if (await persistCancellationIfAborted(signal)) throw new SpeechServiceError("cancelled");
          const completed = await options.operations.complete(input.identity, parsedRequestId.data, {
            executionState: "succeeded",
            outcomeCode: text.length > 0 ? "transcript" : "no_speech",
            actualCostMicrousd,
          }, (trx, reservationId) => options.funding.settle(trx, reservationId, {
            mode: "exact",
            actualCostMicrousd,
          }));
          if (await persistCancellationIfAborted(signal) || completed.cancellationRequested) {
            throw new SpeechServiceError("cancelled");
          }
          return text.length > 0
            ? {
                contractVersion: SPEECH_CONTRACT_VERSION,
                requestId: parsedRequestId.data,
                status: "succeeded",
                outcome: "transcript",
                text,
                audioDurationMs: durationMs,
              }
            : {
                contractVersion: SPEECH_CONTRACT_VERSION,
                requestId: parsedRequestId.data,
                status: "succeeded",
                outcome: "no_speech",
                audioDurationMs: durationMs,
              };
        } catch (error: unknown) {
          let current = await options.operations.get(input.identity, parsedRequestId.data);
          const cancelled = current?.cancellationRequested === true
            || signal.aborted
            || (error instanceof SpeechAdapterError && error.code === "cancelled")
            || (error instanceof SpeechServiceError && error.code === "cancelled");
          const timedOut = error instanceof SpeechAdapterError && error.code === "timeout";
          if (cancelled && current && !current.cancellationRequested) {
            current = await options.operations.cancel(
              input.identity,
              parsedRequestId.data,
              (trx, reservationId) => options.funding.release(trx, reservationId),
            );
          }
          if (current?.executionState === "dispatching") {
            await options.operations.complete(input.identity, parsedRequestId.data, {
              executionState: "uncertain",
              outcomeCode: cancelled ? "cancelled" : timedOut ? "timeout" : "provider_failure",
              actualCostMicrousd: current.reservedMicrousd ?? maximumCostMicrousd,
            }, (trx, reservationId) => options.funding.settle(trx, reservationId, { mode: "conservative" }));
          }
          if (cancelled) throw new SpeechServiceError("cancelled");
          if (timedOut) throw new SpeechServiceError("timeout");
          throw new SpeechServiceError("transcription_failed");
        }
      } finally {
        signal.removeEventListener("abort", requestCancellation);
      }
    } finally {
      const remainingControllers = (active.get(operationKey) ?? []).filter((entry) => entry !== controller);
      if (remainingControllers.length > 0) active.set(operationKey, remainingControllers);
      else active.delete(operationKey);
      activeSlots -= 1;
      activeTasks.delete(taskCompletion.promise);
      taskCompletion.resolve();
    }
  }

  async function status(identity: SpeechOperationIdentity, requestId: string) {
    const operation = await options.operations.get(identity, requestId);
    return operation ? operationStatus(operation) : undefined;
  }

  async function cancel(identity: SpeechOperationIdentity, requestId: string) {
    const operation = await options.operations.cancel(identity, requestId, (trx, reservationId) => (
      options.funding.release(trx, reservationId)
    ));
    const operationKey = `${identity.ownerId}\0${identity.machineId}\0${identity.runtimeSlot}\0${requestId}`;
    for (const controller of active.get(operationKey) ?? []) controller.abort();
    return cancellation(operation);
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownController.abort();
    for (const controllers of active.values()) {
      for (const controller of controllers) controller.abort();
    }
    const pending = [...activeTasks];
    if (pending.length === 0) {
      shutdownPromise = Promise.resolve();
      return shutdownPromise;
    }
    shutdownPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        console.warn("[platform-speech] shutdown drain timed out");
        finish();
      }, shutdownDrainTimeoutMs);
      timeout.unref();
      void Promise.all(pending).then(finish);
    });
    return shutdownPromise;
  }

  return { capabilities, transcribe, status, cancel, shutdown };
}

export function createUnavailablePlatformSpeechService(
  policy: Pick<PlatformSpeechPolicy, "dictation" | "ownerAudio">,
): PlatformSpeechService {
  const unavailable = async (): Promise<never> => {
    throw new SpeechServiceError("unavailable");
  };
  return {
    capabilities: () => ({
      contractVersion: SPEECH_CONTRACT_VERSION,
      fileTranscription: {
        status: "unavailable",
        reason: "disabled",
        dictation: { ...policy.dictation, supportedMediaTypes: [...policy.dictation.supportedMediaTypes] },
        ownerAudio: policy.ownerAudio.enabled
          ? { ...policy.ownerAudio, supportedMediaTypes: [...policy.ownerAudio.supportedMediaTypes] }
          : policy.ownerAudio,
      },
    }),
    transcribe: unavailable,
    status: async () => undefined,
    cancel: unavailable,
    shutdown: async () => undefined,
  };
}
