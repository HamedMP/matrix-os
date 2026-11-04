/** Real PG qualification scenarios. Database execution intentionally remains unverified.
 * Recovery uses the production finalizer/outbox; the canonical runner fails if accidentally invoked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { OWNER, PG_AT, PG_CHAT, PG_LATER, PG_NEXT, backendPid, barrier, behindRoutineLock, bounded, createPgRoutineFixture, pgEnabled, type PgRoutineFixture } from "./routine-postgres-support.js";
describe.skipIf(!pgEnabled)("routine recovery/outbox on pooled PostgreSQL (requires dedicated test DB)", () => {
  let f: PgRoutineFixture | undefined;
  beforeEach(async () => {
    f = await createPgRoutineFixture();
  });
  afterEach(async () => {
    await f?.destroy();
    f = undefined;
  });

  // Removing the finish CAS or publishing on a no-op must produce duplicate events.
  it.each(["expired_dispatch", "invalid_claim"] as const)("two recovery services publish one durable transition for %s", async kind => {
    const fixture = f!,
      fire = await fixture.claim();
    if (kind === "expired_dispatch") await fixture.running(fire.fireId);else await fixture.db.updateTable("chats").set({
      lifecycle: "archived"
    }).where("id", "=", PG_CHAT).execute();
    fixture.setClock(PG_LATER);
    const before = await fixture.events(),
      ready = barrier<void>(),
      pids = new Set<number>();
    const concurrent: BotStateTransactions = (ownerId, work) => fixture.transact(ownerId, async tx => {
      pids.add(await backendPid(tx.db));
      if (pids.size === 2) ready.resolve();
      await bounded(ready.promise);
      return work(tx);
    });
    const results = await Promise.allSettled([fixture.recover(fixture.execution(concurrent)), fixture.recover(fixture.execution(concurrent))]);
    expect(results.filter(result => result.status === "rejected")).toEqual([]);
    expect(pids.size).toBe(2);
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe(kind === "expired_dispatch" ? "uncertain" : "failed");
    const task = (await fixture.tasks.get({
      ownerId: OWNER,
      taskId: fire.taskId
    }))!;
    expect(task.status).toBe("failed");
    const emitted = (await fixture.events()).slice(before.length);
    expect(emitted.map(event => event.event_type)).toEqual(["bot.authority.changed", "bot.task.updated"]);
    expect(emitted[1].payload).toMatchObject({
      taskId: fire.taskId,
      status: "failed",
      revision: task.revision
    });
    await fixture.recover(fixture.execution());
    expect(await fixture.events()).toHaveLength(before.length + 2);
    expect(await fixture.repo.due(PG_NEXT)).toEqual([]);
  });
  it("rolls recovery state and inserted outbox back together, then a new service can recover once", async () => {
    const fixture = f!,
      fire = await fixture.claim();
    await fixture.running(fire.fireId);
    fixture.setClock(PG_LATER);
    const before = await fixture.events(),
      failure = new Error("synthetic recovery publication abort");
    const delivered: string[] = [];
    const registration = fixture.chats.registerOutboxSink(({
      event
    }) => {
      if (event.eventType === "bot.authority.changed" || event.eventType === "bot.task.updated") delivered.push(event.eventType);
    });
    try {
      const aborting: BotStateTransactions = (ownerId, work) => fixture.transact(ownerId, tx => work({
        ...tx,
        publish: async (chatId, type, payload) => {
          await tx.publish(chatId, type, payload);
          expect(delivered).toEqual([]);
          throw failure;
        }
      }));
      await expect(fixture.recover(fixture.execution(aborting))).rejects.toBe(failure);
      expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("dispatched");
      expect((await fixture.tasks.get({
        ownerId: OWNER,
        taskId: fire.taskId
      }))?.status).toBe("running");
      expect(await fixture.events()).toEqual(before);
      expect(delivered).toEqual([]);
      await fixture.recover(fixture.execution());
      expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("uncertain");
      expect(await fixture.events()).toHaveLength(before.length + 2);
      expect(delivered).toEqual(["bot.authority.changed", "bot.task.updated"]);
    } finally {
      registration.dispose();
    }
  });
  it("a recovery snapshot waiting behind successful completion cannot overwrite it", async () => {
    const fixture = f!,
      fire = await fixture.claim();
    await fixture.running(fire.fireId);
    const recovered = await behindRoutineLock(fixture, tx => createBotRoutinesRepository(tx).recover({
      before: PG_LATER,
      now: PG_LATER
    }), tx => createBotRoutinesRepository(tx).finish({
      ownerId: OWNER,
      fireId: fire.fireId,
      status: "completed",
      now: PG_AT
    }));
    expect(recovered).toBe(0);
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("completed");
    expect((await fixture.tasks.get({
      ownerId: OWNER,
      taskId: fire.taskId
    }))?.status).toBe("completed");
  });

  // Recovery must beat stale worker result and keep both canonical outcome and recurrence gate unknown.
  it.each(["completed", "failed"] as const)("recovery committed ahead of late worker %s preserves uncertain and one event pair", async status => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId);
    const before = await fixture.events();
    fixture.setClock(PG_LATER);
    const result = await behindRoutineLock(fixture, tx => fixture.executionIn(tx).completeRun(run.input, {
      status
    }), tx => fixture.recover(fixture.executionIn(tx)));
    expect(result).toEqual({
      status: "uncertain"
    });
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("uncertain");
    expect((await fixture.events()).slice(before.length).map(event => event.event_type)).toEqual(["bot.authority.changed", "bot.task.updated"]);
    expect(await fixture.repo.claim({
      ownerId: OWNER,
      routineId: fixture.routine.routineId,
      scheduledFor: PG_NEXT,
      nextFireAt: null,
      now: PG_LATER
    })).toBeUndefined();
  });
  it.each(["dispatched", "effect_unknown"] as const)("a non-read checkpoint committed while finalization waits retains the %s effect hold", async phase => {
    const fixture = f!,
      fire = await fixture.claim(),
      run = await fixture.running(fire.fireId);
    const before = await fixture.events();
    const result = await behindRoutineLock(fixture, tx => fixture.executionIn(tx).completeRun(run.input, {
      status: "completed"
    }), async tx => {
      const checkpoints = createBotCheckpointsRepository(tx);
      const {
        checkpoint
      } = await checkpoints.prepare({
        ownerId: OWNER,
        taskId: fire.taskId,
        runId: run.input.runId,
        toolCallId: "call_pg_unknown",
        action: {
          capability: "integration.call"
        },
        effectClass: "send",
        now: PG_AT
      });
      await checkpoints.markDispatched({
        ownerId: OWNER,
        checkpointId: checkpoint.checkpointId,
        now: PG_AT
      });
      if (phase === "effect_unknown") await checkpoints.markEffectUnknown({
        ownerId: OWNER,
        checkpointId: checkpoint.checkpointId,
        now: PG_AT
      });
    });
    expect(result).toEqual({
      status: "uncertain"
    });
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.failureCode).toBe("effect_outcome_unknown");
    expect((await fixture.events()).slice(before.length).map(event => event.event_type)).toEqual(["bot.authority.changed", "bot.task.updated"]);
    expect(await fixture.repo.due(PG_NEXT)).toEqual([]);
  });
});
