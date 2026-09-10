import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import {
  SpeechOperationRateLimitError,
  createSpeechOperationsRepository,
  type SpeechOperationsRepository,
} from "../../packages/platform/src/speech/operations.js";
import {
  SpeechAdapterError,
  type FileTranscriptionAdapter,
} from "../../packages/platform/src/speech/adapters/openai.js";
import {
  SpeechServiceError,
  createPlatformSpeechService,
  type PlatformSpeechPolicy,
  type SpeechFundingPort,
} from "../../packages/platform/src/speech/service.js";
import { SpeechFundingError } from "../../packages/platform/src/speech/funding.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

const now = new Date("2026-09-10T00:00:00.000Z");
const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
const requestId = `sp_${now.getTime()}_abcdefghijklmnop`;

function oneSecondWav(): Uint8Array {
  const samples = 16_000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

describe("platform speech service", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: identity.machineId,
      clerkUserId: identity.ownerId,
      handle: "alice",
      runtimeSlot: identity.runtimeSlot,
      status: "running",
      imageVersion: "v1",
      provisionedAt: "2026-09-09T00:00:00.000Z",
      activationState: "authorized",
    });
  });

  afterEach(async () => destroyTestPlatformDb(db));

  const policy: PlatformSpeechPolicy = {
    enabled: true,
    revision: "speech-policy-1",
    modelId: "gpt-transcribe",
    microusdPerMinute: 60,
    dictation: {
      enabled: true,
      maxBytes: 10 * 1024 * 1024,
      maxDurationMs: 120_000,
      maxTranscriptChars: 32_000,
      supportedMediaTypes: ["audio/wav"],
      languageHints: false,
    },
    ownerAudio: { enabled: false },
  };

  function service(options: {
    operations?: SpeechOperationsRepository;
    funding?: SpeechFundingPort;
    adapter?: FileTranscriptionAdapter;
    policy?: PlatformSpeechPolicy;
  } = {}) {
    const operations = options.operations ?? createSpeechOperationsRepository({ db, now: () => now });
    const funding = options.funding ?? {
      reserve: vi.fn(async () => ({ reservationId: "funding_1", reservedMicrousd: 120 })),
      start: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const adapter = options.adapter
      ?? { id: "openai-file", transcribe: vi.fn(async () => ({ text: "hello world" })) };
    return {
      funding,
      adapter,
      speech: createPlatformSpeechService({
        operations,
        funding,
        adapter,
        fingerprintSecret: "f".repeat(32),
        policy: options.policy ?? policy,
      }),
    };
  }

  it("reserves, claims, transcribes and settles before returning final text", async () => {
    const { speech, funding, adapter } = service();
    await expect(speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: "transcript", text: "hello world", audioDurationMs: 1_000 });
    expect(funding.reserve).toHaveBeenCalledTimes(1);
    expect(funding.start).toHaveBeenCalledTimes(1);
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "exact",
      actualCostMicrousd: 1,
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "succeeded",
      outcomeCode: "transcript",
    });
  });

  it.each([
    ["allowance_exhausted", "allowance_exhausted"],
    ["unavailable", "unavailable"],
  ] as const)("maps funding %s without exposing wallet internals", async (fundingCode, serviceCode) => {
    const funding: SpeechFundingPort = {
      reserve: vi.fn(async () => { throw new SpeechFundingError(fundingCode); }),
      start: vi.fn(async () => undefined),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const { speech, adapter } = service({ funding });
    const error = await speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechServiceError);
    expect(error).toMatchObject({ code: serviceCode });
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toMatch(/credit|balance|reservation|machine_123/i);
  });

  it("maps durable admission pressure to the safe rate-limit contract", async () => {
    const repository = createSpeechOperationsRepository({ db, now: () => now });
    const operations: SpeechOperationsRepository = {
      ...repository,
      admit: vi.fn(async () => { throw new SpeechOperationRateLimitError(); }),
    };
    const { speech, funding, adapter } = service({ operations });
    const error = await speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechServiceError);
    expect(error).toMatchObject({ code: "rate_limited" });
    expect(funding.reserve).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("advertises only transcript limits accepted by the response contract", () => {
    const ownerAudioPolicy: PlatformSpeechPolicy = {
      ...policy,
      ownerAudio: {
        enabled: true,
        maxBytes: 64 * 1024 * 1024,
        maxDurationMs: 60 * 60_000,
        maxTranscriptChars: 32_000,
        supportedMediaTypes: ["audio/wav"],
        languageHints: false,
      },
    };
    expect(service({ policy: ownerAudioPolicy }).speech.capabilities().fileTranscription)
      .toMatchObject({
        dictation: { maxTranscriptChars: 32_000 },
        ownerAudio: { maxTranscriptChars: 32_000 },
      });
    expect(() => service({
      policy: {
        ...ownerAudioPolicy,
        ownerAudio: { ...ownerAudioPolicy.ownerAudio, maxTranscriptChars: 32_001 },
      },
    })).toThrow("Speech transcript limit is invalid");
  });

  it("does not redispatch or replay transcript content for a repeated POST", async () => {
    const { speech, adapter } = service();
    const input = {
      identity,
      requestId,
      sourceKind: "dictation" as const,
      audio: oneSecondWav(),
      mediaType: "audio/wav" as const,
      signal: new AbortController().signal,
    };
    await speech.transcribe(input);
    const replay = await speech.transcribe(input).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(SpeechServiceError);
    expect(replay).toMatchObject({ code: "result_not_replayable" });
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
  });

  it("rejects request-id reuse with different language hints", async () => {
    const hintedPolicy: PlatformSpeechPolicy = {
      ...policy,
      dictation: { ...policy.dictation, languageHints: true },
    };
    const adapterStarted = Promise.withResolvers<void>();
    const allowAdapter = Promise.withResolvers<void>();
    const adapter: FileTranscriptionAdapter = {
      id: "openai-file",
      transcribe: vi.fn(async () => {
        adapterStarted.resolve();
        await allowAdapter.promise;
        return { text: "hello world" };
      }),
    };
    const { speech } = service({ adapter, policy: hintedPolicy });
    const first = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      languageHints: ["en"],
      signal: new AbortController().signal,
    });
    await adapterStarted.promise;
    await expect(speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      languageHints: ["fr"],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "request_conflict" });
    allowAdapter.resolve();
    await expect(first).resolves.toMatchObject({ outcome: "transcript" });
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
    expect(adapter.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      languageHints: ["en"],
    }));
  });

  it("honors cancel-before-registration and exposes no provider details", async () => {
    const { speech, adapter } = service();
    await speech.cancel(identity, requestId);
    const error = await speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toMatch(/openai|funding_1|machine_123/i);
  });

  it("rejects pre-aborted input before admission or allowance reservation", async () => {
    const operations = createSpeechOperationsRepository({ db, now: () => now });
    const claimDispatch = vi.spyOn(operations, "claimDispatch");
    const controller = new AbortController();
    controller.abort();
    const { speech, funding, adapter } = service({ operations });
    await expect(speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(funding.reserve).not.toHaveBeenCalled();
    expect(funding.release).not.toHaveBeenCalled();
    expect(funding.settle).not.toHaveBeenCalled();
    expect(claimDispatch).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(await operations.get(identity, requestId)).toBeUndefined();
  });

  it("releases once and never dispatches when aborted after admission", async () => {
    const controller = new AbortController();
    const repository = createSpeechOperationsRepository({ db, now: () => now });
    const operations: SpeechOperationsRepository = {
      ...repository,
      admit: async (...args) => {
        const admitted = await repository.admit(...args);
        controller.abort();
        return admitted;
      },
      claimDispatch: vi.fn(repository.claimDispatch),
    };
    const { speech, funding, adapter } = service({ operations });
    await expect(speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(funding.reserve).toHaveBeenCalledTimes(1);
    expect(funding.release).toHaveBeenCalledTimes(1);
    expect(funding.settle).not.toHaveBeenCalled();
    expect(operations.claimDispatch).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: false,
      retrySafety: "terminal_no_retry_needed",
      outcomeCode: "cancelled",
    });
  });

  it("races caller abort against an in-flight dispatch claim durably", async () => {
    const caller = new AbortController();
    const repository = createSpeechOperationsRepository({ db, now: () => now });
    const claimEntered = Promise.withResolvers<void>();
    const allowClaim = Promise.withResolvers<void>();
    const operations: SpeechOperationsRepository = {
      ...repository,
      claimDispatch: vi.fn(async (...args) => {
        claimEntered.resolve();
        await allowClaim.promise;
        return repository.claimDispatch(...args);
      }),
    };
    const { speech, funding, adapter } = service({ operations });
    const result = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: caller.signal,
    });
    await claimEntered.promise;
    caller.abort();
    await vi.waitFor(() => expect(funding.release).toHaveBeenCalledTimes(1));
    allowClaim.resolve();

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(operations.claimDispatch).toHaveBeenCalledTimes(1);
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(funding.settle).not.toHaveBeenCalled();
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: false,
      outcomeCode: "cancelled",
    });
  });

  it("settles conservatively when caller abort follows a committed dispatch claim", async () => {
    const caller = new AbortController();
    const repository = createSpeechOperationsRepository({ db, now: () => now });
    const operations: SpeechOperationsRepository = {
      ...repository,
      claimDispatch: vi.fn(async (...args) => {
        const claimed = await repository.claimDispatch(...args);
        caller.abort();
        return claimed;
      }),
    };
    const { speech, funding, adapter } = service({ operations });

    await expect(speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: caller.signal,
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(funding.release).not.toHaveBeenCalled();
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "conservative",
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "uncertain",
      cancellationRequested: true,
      executionStarted: true,
      outcomeCode: "cancelled",
    });
  });

  it("settles conservatively when cancellation follows the dispatch claim", async () => {
    const adapterStarted = Promise.withResolvers<void>();
    const adapter: FileTranscriptionAdapter = {
      id: "openai-file",
      transcribe: vi.fn(async ({ signal }) => {
        adapterStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            new SpeechAdapterError("cancelled", "Transcription was cancelled"),
          ), { once: true });
        });
        return { text: "unreachable" };
      }),
    };
    const { speech, funding } = service({ adapter });
    const result = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    });
    await adapterStarted.promise;
    await speech.cancel(identity, requestId);
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
    expect(funding.release).not.toHaveBeenCalled();
    expect(funding.settle).toHaveBeenCalledTimes(1);
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "conservative",
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "uncertain",
      cancellationRequested: true,
      executionStarted: true,
      retrySafety: "new_request_may_consume_allowance",
      outcomeCode: "cancelled",
    });
  });

  it("persists caller abort after dispatch before conservative settlement", async () => {
    const adapterStarted = Promise.withResolvers<void>();
    const adapter: FileTranscriptionAdapter = {
      id: "openai-file",
      transcribe: vi.fn(async ({ signal }) => {
        adapterStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            new SpeechAdapterError("cancelled", "Transcription was cancelled"),
          ), { once: true });
        });
        return { text: "unreachable" };
      }),
    };
    const caller = new AbortController();
    const { speech, funding } = service({ adapter });
    const result = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: caller.signal,
    });
    await adapterStarted.promise;
    caller.abort();

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
    expect(funding.release).not.toHaveBeenCalled();
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "conservative",
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "uncertain",
      cancellationRequested: true,
      executionStarted: true,
      outcomeCode: "cancelled",
    });
  });

  it("suppresses a successful adapter result when caller abort wins after dispatch", async () => {
    const adapterStarted = Promise.withResolvers<void>();
    const allowAdapterSuccess = Promise.withResolvers<void>();
    const adapter: FileTranscriptionAdapter = {
      id: "openai-file",
      transcribe: vi.fn(async () => {
        adapterStarted.resolve();
        await allowAdapterSuccess.promise;
        return { text: "must not be delivered" };
      }),
    };
    const caller = new AbortController();
    const { speech, funding } = service({ adapter });
    const result = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: caller.signal,
    });
    await adapterStarted.promise;
    caller.abort();
    allowAdapterSuccess.resolve();

    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(funding.release).not.toHaveBeenCalled();
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "conservative",
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "uncertain",
      cancellationRequested: true,
      executionStarted: true,
      outcomeCode: "cancelled",
    });
  });

  it("preserves adapter deadline semantics through conservative settlement", async () => {
    const adapter: FileTranscriptionAdapter = {
      id: "openai-file",
      transcribe: vi.fn(async () => {
        throw new SpeechAdapterError("timeout", "Transcription timed out");
      }),
    };
    const { speech, funding } = service({ adapter });
    await expect(speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "timeout" });
    expect(funding.release).not.toHaveBeenCalled();
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "conservative",
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "uncertain",
      cancellationRequested: false,
      executionStarted: true,
      retrySafety: "new_request_may_consume_allowance",
      outcomeCode: "timeout",
    });
  });

  it("drains shutdown after admission before dispatch and releases the hold", async () => {
    const repository = createSpeechOperationsRepository({ db, now: () => now });
    const admissionFinished = Promise.withResolvers<void>();
    const allowAdmissionReturn = Promise.withResolvers<void>();
    const operations: SpeechOperationsRepository = {
      ...repository,
      admit: vi.fn(async (...args) => {
        const admitted = await repository.admit(...args);
        admissionFinished.resolve();
        await allowAdmissionReturn.promise;
        return admitted;
      }),
      claimDispatch: vi.fn(repository.claimDispatch),
    };
    const { speech, funding, adapter } = service({ operations });
    const result = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    });
    await admissionFinished.promise;
    let shutdownFinished = false;
    const shutdown = Promise.resolve(speech.shutdown()).then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    allowAdmissionReturn.resolve();

    await shutdown;
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(operations.claimDispatch).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(funding.release).toHaveBeenCalledTimes(1);
    expect(funding.settle).not.toHaveBeenCalled();
  });

  it("drains shutdown after a dispatch claim without starting the adapter", async () => {
    const repository = createSpeechOperationsRepository({ db, now: () => now });
    const claimCommitted = Promise.withResolvers<void>();
    const allowClaimReturn = Promise.withResolvers<void>();
    const operations: SpeechOperationsRepository = {
      ...repository,
      claimDispatch: vi.fn(async (...args) => {
        const claim = await repository.claimDispatch(...args);
        claimCommitted.resolve();
        await allowClaimReturn.promise;
        return claim;
      }),
    };
    const { speech, funding, adapter } = service({ operations });
    const result = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    });
    await claimCommitted.promise;
    let shutdownFinished = false;
    const shutdown = Promise.resolve(speech.shutdown()).then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    allowClaimReturn.resolve();

    await shutdown;
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(funding.release).not.toHaveBeenCalled();
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "conservative",
    });
  });

  it("waits for in-flight cancellation settlement before shutdown resolves", async () => {
    const adapterStarted = Promise.withResolvers<void>();
    const settleEntered = Promise.withResolvers<void>();
    const allowSettlement = Promise.withResolvers<void>();
    const adapter: FileTranscriptionAdapter = {
      id: "openai-file",
      transcribe: vi.fn(async ({ signal }) => {
        adapterStarted.resolve();
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => {
          reject(new SpeechAdapterError("cancelled", "Transcription was cancelled"));
        }, { once: true }));
        return { text: "unreachable" };
      }),
    };
    const funding: SpeechFundingPort = {
      reserve: vi.fn(async () => ({ reservationId: "funding_1", reservedMicrousd: 120 })),
      start: vi.fn(async () => undefined),
      settle: vi.fn(async () => {
        settleEntered.resolve();
        await allowSettlement.promise;
      }),
      release: vi.fn(async () => undefined),
    };
    const { speech } = service({ adapter, funding });
    const result = speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    });
    await adapterStarted.promise;
    let shutdownFinished = false;
    const shutdown = Promise.resolve(speech.shutdown()).then(() => { shutdownFinished = true; });
    await settleEntered.promise;
    expect(shutdownFinished).toBe(false);
    allowSettlement.resolve();

    await shutdown;
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(funding.settle).toHaveBeenCalledTimes(1);
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "uncertain",
      cancellationRequested: true,
      outcomeCode: "cancelled",
    });
  });
});
