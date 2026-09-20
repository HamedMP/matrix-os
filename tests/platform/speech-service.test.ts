import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";
import { createSpeechOperationsRepository } from "../../packages/platform/src/speech/operations.js";
import {
  SpeechServiceError,
  createPlatformSpeechService,
} from "../../packages/platform/src/speech/service.js";
import { SpeechAdapterError } from "../../packages/platform/src/speech/adapters/openai.js";
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

  function service(cleanup?: { cleanupIntervalMs: number; cleanupBatchSize: number }) {
    const operations = createSpeechOperationsRepository({ db, now: () => now });
    const funding = {
      reserve: vi.fn(async () => ({ reservationId: "funding_1", reservedMicrousd: 120 })),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const adapter = { id: "openai-file", transcribe: vi.fn(async () => ({ text: "hello world" })) };
    return {
      funding,
      adapter,
      speech: createPlatformSpeechService({
        operations,
        funding,
        adapter,
        fingerprintSecret: "f".repeat(32),
        policy: {
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
        },
        ...cleanup,
      }),
      operations,
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
    expect(adapter.transcribe).toHaveBeenCalledTimes(1);
    expect(funding.settle).toHaveBeenCalledWith(expect.anything(), "funding_1", {
      mode: "exact",
      actualCostMicrousd: 1,
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "succeeded",
      outcomeCode: "transcript",
    });
    await expect(speech.cancel(identity, requestId)).rejects.toMatchObject({
      code: "result_not_replayable",
    });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "succeeded",
      cancellationRequested: false,
    });
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

  it("preserves provider timeout identity for 504 route mapping", async () => {
    const { speech, adapter } = service();
    adapter.transcribe.mockRejectedValueOnce(new SpeechAdapterError("timeout", "private timeout detail"));
    await expect(speech.transcribe({
      identity,
      requestId,
      sourceKind: "dictation",
      audio: oneSecondWav(),
      mediaType: "audio/wav",
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "timeout" });
    expect(await speech.status(identity, requestId)).toMatchObject({
      executionState: "uncertain",
      outcomeCode: "timeout",
    });
  });

  it("runs bounded metadata cleanup until shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { speech, operations } = service({ cleanupIntervalMs: 1_000, cleanupBatchSize: 7 });
      let releaseSweep!: () => void;
      const blockedSweep = new Promise<number>((resolve) => { releaseSweep = () => resolve(0); });
      const sweep = vi.spyOn(operations, "sweepExpired").mockReturnValue(blockedSweep);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweep).toHaveBeenCalledWith(7);
      let shutdownFinished = false;
      const shutdown = speech.shutdown().then(() => { shutdownFinished = true; });
      await Promise.resolve();
      expect(shutdownFinished).toBe(false);
      releaseSweep();
      await shutdown;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sweep).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
