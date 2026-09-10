import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUserMachine, createPlatformDb, type PlatformDB } from "../../packages/platform/src/db.js";
import { createSpeechOperationsRepository } from "../../packages/platform/src/speech/operations.js";
import {
  createPlatformSpeechService,
  type PlatformSpeechPolicy,
} from "../../packages/platform/src/speech/service.js";

const postgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const describePostgres = postgresUrl ? describe : describe.skip;
const now = new Date("2026-09-10T00:00:00.000Z");
const identity = { ownerId: "user_speech_race", machineId: "machine_speech_race", runtimeSlot: "primary" } as const;

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

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describePostgres("speech operation PostgreSQL concurrency", () => {
  const schema = `speech_review_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let dbA: PlatformDB;
  let dbB: PlatformDB;

  function connectionUrl(applicationName: string): string {
    if (!postgresUrl) throw new Error("MATRIX_TEST_POSTGRES_URL is required");
    const url = new URL(postgresUrl);
    if (!url.pathname.toLowerCase().includes("test")) {
      throw new Error("MATRIX_TEST_POSTGRES_URL must name a test database");
    }
    const existingOptions = url.searchParams.get("options") ?? "";
    url.searchParams.set("options", [
      existingOptions,
      `-c search_path=${schema},public`,
      "-c statement_timeout=5000",
      "-c lock_timeout=4000",
    ].filter(Boolean).join(" "));
    url.searchParams.set("application_name", applicationName);
    return url.toString();
  }

  async function waitForLock(applicationName: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ waiting: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock'
        ) AS waiting
      `, [applicationName]);
      if (result.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} to block on a row lock`);
  }

  beforeAll(async () => {
    if (!postgresUrl) return;
    const databaseUrl = new URL(postgresUrl);
    if (!databaseUrl.pathname.toLowerCase().includes("test")) {
      throw new Error("MATRIX_TEST_POSTGRES_URL must name a test database");
    }
    admin = new pg.Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    dbA = createPlatformDb(connectionUrl("speech-review-a"));
    await dbA.ready;
    dbB = createPlatformDb(connectionUrl("speech-review-b"));
    await dbB.ready;
    await insertUserMachine(dbA, {
      machineId: identity.machineId,
      clerkUserId: identity.ownerId,
      handle: "speech-race",
      runtimeSlot: identity.runtimeSlot,
      status: "running",
      imageVersion: "v1",
      provisionedAt: "2026-09-09T00:00:00.000Z",
      activationState: "authorized",
    });
  });

  beforeEach(async () => {
    await dbA.executor.deleteFrom("speech_operations").execute();
  });

  afterAll(async () => {
    if (!postgresUrl) return;
    await Promise.all([dbA?.destroy(), dbB?.destroy()]);
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  function admission(requestId: string) {
    return {
      identity,
      requestId,
      sourceKind: "dictation" as const,
      contentFingerprint: "a".repeat(64),
      policyRevision: "speech-policy-1",
      adapterId: "adapter-a",
      modelId: "model-a",
      audioDurationMs: 1_000,
      maximumCostMicrousd: 20,
    };
  }

  it("lets cancellation win a row-lock race without dispatch and releases once", async () => {
    const requestId = `sp_${now.getTime()}_cancelwinsraceaaa`;
    const repoA = createSpeechOperationsRepository({ db: dbA, now: () => now });
    const repoB = createSpeechOperationsRepository({ db: dbB, now: () => now });
    await repoA.admit(admission(requestId), async () => ({ reservationId: "funding_1", reservedMicrousd: 20 }));
    const releaseEntered = deferred<void>();
    const allowRelease = deferred<void>();
    let releases = 0;
    const cancelling = repoA.cancel(identity, requestId, async () => {
      releases += 1;
      releaseEntered.resolve();
      await allowRelease.promise;
    });
    await releaseEntered.promise;
    const claiming = repoB.claimDispatch(identity, requestId);
    await waitForLock("speech-review-b");
    allowRelease.resolve();

    await expect(cancelling).resolves.toMatchObject({
      executionState: "cancelled",
      cancellationRequested: true,
      executionStarted: false,
    });
    await expect(claiming).resolves.toMatchObject({ claimed: false });
    expect(releases).toBe(1);
    expect(await repoB.get(identity, requestId)).toMatchObject({
      executionState: "cancelled",
      executionStarted: false,
    });
  });

  it("lets a committed dispatch claim win without releasing its hold", async () => {
    const requestId = `sp_${now.getTime()}_dispatchwinsracea`;
    const repoA = createSpeechOperationsRepository({ db: dbA, now: () => now });
    const repoB = createSpeechOperationsRepository({ db: dbB, now: () => now });
    await repoA.admit(admission(requestId), async () => ({ reservationId: "funding_2", reservedMicrousd: 20 }));
    const claimEntered = deferred<void>();
    const allowClaimCommit = deferred<void>();
    const claiming = dbA.transaction(async (trx) => {
      const transactionalRepo = createSpeechOperationsRepository({ db: trx, now: () => now });
      const claim = await transactionalRepo.claimDispatch(identity, requestId);
      claimEntered.resolve();
      await allowClaimCommit.promise;
      return claim;
    });
    await claimEntered.promise;
    let releases = 0;
    const cancelling = repoB.cancel(identity, requestId, async () => { releases += 1; });
    await waitForLock("speech-review-b");
    allowClaimCommit.resolve();

    await expect(claiming).resolves.toMatchObject({ claimed: true });
    await expect(cancelling).resolves.toMatchObject({
      executionState: "dispatching",
      cancellationRequested: true,
      executionStarted: true,
    });
    expect(releases).toBe(0);
  });

  it("rejects a raced adapter/model binding and only invokes the persisted adapter", async () => {
    const requestId = `sp_${now.getTime()}_immutablebinding`;
    const repoA = createSpeechOperationsRepository({ db: dbA, now: () => now });
    const repoB = createSpeechOperationsRepository({ db: dbB, now: () => now });
    const reserveEntered = deferred<void>();
    const allowReserve = deferred<void>();
    const adapterA = { id: "adapter-a", transcribe: vi.fn(async () => ({ text: "from a" })) };
    const adapterB = { id: "adapter-b", transcribe: vi.fn(async () => ({ text: "from b" })) };
    const basePolicy: PlatformSpeechPolicy = {
      enabled: true,
      revision: "speech-policy-1",
      modelId: "model-a",
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
    const fundingA = {
      reserve: vi.fn(async () => {
        reserveEntered.resolve();
        await allowReserve.promise;
        return { reservationId: "funding_a", reservedMicrousd: 120 };
      }),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const fundingB = {
      reserve: vi.fn(async () => ({ reservationId: "funding_b", reservedMicrousd: 120 })),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const serviceA = createPlatformSpeechService({
      operations: repoA,
      funding: fundingA,
      adapter: adapterA,
      fingerprintSecret: "f".repeat(32),
      policy: basePolicy,
    });
    const serviceB = createPlatformSpeechService({
      operations: repoB,
      funding: fundingB,
      adapter: adapterB,
      fingerprintSecret: "f".repeat(32),
      policy: { ...basePolicy, modelId: "model-b" },
    });
    const input = {
      identity,
      requestId,
      sourceKind: "dictation" as const,
      audio: oneSecondWav(),
      mediaType: "audio/wav" as const,
      signal: new AbortController().signal,
    };
    const first = serviceA.transcribe(input);
    await reserveEntered.promise;
    const second = serviceB.transcribe(input);
    const secondExpectation = expect(second).rejects.toMatchObject({ code: "request_conflict" });
    await waitForLock("speech-review-b");
    allowReserve.resolve();

    await expect(first).resolves.toMatchObject({ outcome: "transcript", text: "from a" });
    await secondExpectation;
    expect(adapterA.transcribe).toHaveBeenCalledTimes(1);
    expect(adapterB.transcribe).not.toHaveBeenCalled();
    expect(fundingA.reserve).toHaveBeenCalledTimes(1);
    expect(fundingB.reserve).not.toHaveBeenCalled();
    expect(await repoA.get(identity, requestId)).toMatchObject({
      adapterId: "adapter-a",
      modelId: "model-a",
      executionState: "succeeded",
    });
  });
});
