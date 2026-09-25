import { describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { JEV_EMAIL_TRIAGE_ANSWER_IDS, JEV_MODEL_ID } from "@matrix-os/contracts";
import { startJevResultCleanup } from "../../packages/gateway/src/jev/result-cleanup.js";
import { initializeJevRuntime } from "../../packages/gateway/src/jev/runtime.js";
import { JevEvaluationRepository } from "../../packages/gateway/src/jev/repository.js";

describe("Jev result cleanup lifecycle", () => {
  it("does not initialize a funded route without an owner database", async () => {
    await expect(initializeJevRuntime({
      db: null,
      credentialProvider: null,
      fundedRuntimeEnabled: true,
    })).resolves.toBeNull();
  });

  it("starts without a claim, coalesces ticks, and stops before future sweeps", async () => {
    let tick: (() => void) | undefined;
    let finishSweep: (() => void) | undefined;
    const pruneExpiredCompletedResults = vi.fn(() => new Promise<void>((resolve) => {
      finishSweep = resolve;
    }));
    const cancel = vi.fn();
    const lifecycle = startJevResultCleanup({
      repository: { pruneExpiredCompletedResults },
      schedule(callback, intervalMs) {
        expect(intervalMs).toBe(60_000);
        tick = callback;
        return "timer";
      },
      cancel,
    });

    expect(pruneExpiredCompletedResults).toHaveBeenCalledTimes(1);
    tick?.();
    const overlapping = lifecycle.runNow();
    expect(pruneExpiredCompletedResults).toHaveBeenCalledTimes(1);
    finishSweep?.();
    await overlapping;

    tick?.();
    expect(pruneExpiredCompletedResults).toHaveBeenCalledTimes(2);
    const closing = lifecycle.close();
    expect(cancel).toHaveBeenCalledWith("timer");
    finishSweep?.();
    await closing;
    tick?.();
    await lifecycle.runNow();
    expect(pruneExpiredCompletedResults).toHaveBeenCalledTimes(2);
  });

  it("maintains prior Jev data while the funded route is disabled", async () => {
    const pglite = await KyselyPGlite.create();
    let clock = new Date("2026-09-22T10:00:00.000Z");
    const prior = new JevEvaluationRepository(pglite.dialect, { now: () => clock });
    const key = { ownerId: "owner_a", idempotencyKey: "thread:prior123", payloadHash: "a".repeat(64) };
    await prior.bootstrap();
    await prior.claim(key);
    await prior.complete({
      ...key,
      result: {
        requestId: "jev_req_request_123",
        recipe: "email-triage-v1",
        model: JEV_MODEL_ID,
        latencyMs: 1,
        answers: JEV_EMAIL_TRIAGE_ANSWER_IDS.map((id) => ({ id, type: "boolean", probability: 0.5 })),
      },
    });
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60_000 + 1);

    const runtime = await initializeJevRuntime({
      db: prior.kysely,
      credentialProvider: null,
      fundedRuntimeEnabled: false,
      now: () => clock,
      schedule: () => "timer",
      cancel: () => undefined,
    });
    expect(runtime?.service).toBeNull();
    await runtime?.cleanup.runNow();
    const row = await prior.kysely.selectFrom("jev_evaluations")
      .select(["status", "result"])
      .where("owner_id", "=", key.ownerId)
      .where("idempotency_key", "=", key.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "completed_pruned", result: null });
    await runtime?.cleanup.close();
    await prior.destroy();
  });
});
