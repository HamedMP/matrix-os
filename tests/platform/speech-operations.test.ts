import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transaction } from "kysely";
import type { PlatformDatabase } from "../../packages/platform/src/db.js";
import {
  SpeechOperationConflictError,
  createSpeechOperationsRepository,
} from "../../packages/platform/src/speech/operations.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";
import { insertUserMachine, type PlatformDB } from "../../packages/platform/src/db.js";

const identity = { ownerId: "user_alice", machineId: "machine_123", runtimeSlot: "primary" } as const;
const now = new Date("2026-09-10T00:00:00.000Z");
const requestId = `sp_${now.getTime()}_abcdefghijklmnop`;

describe("speech operation repository", () => {
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

  function repository() {
    return createSpeechOperationsRepository({ db, now: () => now });
  }

  const admission = {
    identity,
    requestId,
    sourceKind: "dictation" as const,
    contentFingerprint: "a".repeat(64),
    policyRevision: "speech-policy-1",
    adapterId: "openai-file",
    modelId: "gpt-transcribe",
    audioDurationMs: 1_000,
    maximumCostMicrousd: 20,
  };

  it("atomically creates and links one funding reservation", async () => {
    const repo = repository();
    let reserveCalls = 0;
    const reserve = async (_trx: Transaction<PlatformDatabase>) => {
      reserveCalls += 1;
      return { reservationId: "funding_1", reservedMicrousd: 20 };
    };
    const first = await repo.admit(admission, reserve);
    const replay = await repo.admit(admission, reserve);
    expect(first).toMatchObject({ executionState: "reserved", fundingReservationId: "funding_1" });
    expect(replay).toEqual(first);
    expect(reserveCalls).toBe(1);
    await expect(repo.admit({ ...admission, contentFingerprint: "b".repeat(64) }, reserve))
      .rejects.toBeInstanceOf(SpeechOperationConflictError);
  });

  it("grants one durable dispatch claim rather than replaying a start receipt", async () => {
    const repo = repository();
    await repo.admit(admission, async () => ({ reservationId: "funding_1", reservedMicrousd: 20 }));
    const [first, second] = await Promise.all([
      repo.claimDispatch(identity, requestId),
      repo.claimDispatch(identity, requestId),
    ]);
    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    expect((await repo.get(identity, requestId))?.executionState).toBe("dispatching");
  });

  it("uses a cancellation tombstone to prevent late registration", async () => {
    const repo = repository();
    expect(await repo.cancel(identity, requestId, async () => undefined)).toMatchObject({
      executionStarted: false,
      cancellationRequested: true,
    });
    let reserveCalls = 0;
    const cancelled = await repo.admit(admission, async () => {
      reserveCalls += 1;
      return { reservationId: "funding_1", reservedMicrousd: 20 };
    });
    expect(cancelled.executionState).toBe("cancelled");
    expect(reserveCalls).toBe(0);
  });

  it("settles outcome metadata atomically and never stores transcript or audio", async () => {
    const repo = repository();
    await repo.admit(admission, async () => ({ reservationId: "funding_1", reservedMicrousd: 20 }));
    await repo.claimDispatch(identity, requestId);
    let settleCalls = 0;
    const completed = await repo.complete(identity, requestId, {
      executionState: "succeeded",
      outcomeCode: "transcript",
      actualCostMicrousd: 15,
    }, async (_trx, reservationId, actualCostMicrousd) => {
      settleCalls += 1;
      expect({ reservationId, actualCostMicrousd }).toEqual({ reservationId: "funding_1", actualCostMicrousd: 15 });
    });
    expect(completed).toMatchObject({ executionState: "succeeded", actualCostMicrousd: 15 });
    expect(settleCalls).toBe(1);
    const row = await db.executor.selectFrom("speech_operations").selectAll().executeTakeFirstOrThrow();
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["audio", "transcript", "text"]));
    expect(JSON.stringify(row)).not.toContain("private transcript");
  });

  it("marks cancellation after dispatch without releasing a possibly billable hold", async () => {
    const repo = repository();
    await repo.admit(admission, async () => ({ reservationId: "funding_1", reservedMicrousd: 20 }));
    await repo.claimDispatch(identity, requestId);
    let releases = 0;
    const cancelled = await repo.cancel(identity, requestId, async () => { releases += 1; });
    expect(cancelled).toMatchObject({ executionStarted: true, cancellationRequested: true });
    expect(releases).toBe(0);
    expect((await repo.get(identity, requestId))?.executionState).toBe("dispatching");
  });
});
