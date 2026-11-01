/** Qualification code only: real PG connections/locks, never a PGlite fallback.
 * NOT RUN in the database-free preparation phase. No model/worker is launched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBotRoutinesRepository, type BotRoutineFire } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BOT, OWNER, PG_AT, PG_CHAT, PG_NEXT, backendPid, barrier, behindRoutineLock, bounded, createPgRoutineFixture, pgEnabled, type PgRoutineFixture } from "./routine-postgres-support.js";
describe.skipIf(!pgEnabled)("routine occurrence/control on pooled PostgreSQL (requires dedicated test DB)", () => {
  let f: PgRoutineFixture | undefined;
  beforeEach(async () => {
    f = await createPgRoutineFixture();
  });
  afterEach(async () => {
    await f?.destroy();
    f = undefined;
  });

  // Removing the routine row lock/occurrence gate must permit duplicate task allocation and fail these assertions.
  it("samples the resume clock after waiting for the routine lock", async () => {
    const fixture = f!, current = fixture.routine;
    const paused = await fixture.repo.control({ ownerId: OWNER, routineId: current.routineId,
      baseRevision: current.revision, status: "paused", now: PG_AT });
    const later = "2026-09-27T12:16:00.000Z";
    fixture.setClock(PG_AT);
    const resumed = await behindRoutineLock(fixture, tx => fixture.executionIn(tx).control(OWNER, BOT, current.routineId, {
      baseRevision: paused.revision, status: "active",
    }), async () => { fixture.setClock(later); });
    expect(resumed.nextFireAt).toBe("2026-09-27T12:17:00.000Z");
    expect(resumed.updatedAt).toBe(later);
    expect(await fixture.repo.due(later)).toEqual([]);
  });

  it("a claim blocked behind the winning claim cannot allocate a second fire/task", async () => {
    const fixture = f!;
    let winner: BotRoutineFire | undefined;
    const claim = {
      ownerId: OWNER,
      routineId: fixture.routine.routineId,
      scheduledFor: PG_AT,
      nextFireAt: PG_NEXT,
      now: PG_AT
    };
    const loser = await behindRoutineLock(fixture, tx => createBotRoutinesRepository(tx).claim(claim), async tx => {
      winner = await createBotRoutinesRepository(tx).claim(claim);
    });
    expect(winner).toBeDefined();
    expect(loser).toBeUndefined();
    expect(await fixture.repo.fires(OWNER, fixture.routine.routineId)).toHaveLength(1);
    const tasks = await fixture.db.selectFrom("bot_tasks").select("task_id").where("owner_id", "=", OWNER).where("task_id", "!=", fixture.binding.taskId).execute();
    expect(tasks).toEqual([{
      task_id: winner!.taskId
    }]);
  });
  it("eight distinct PG sessions claim one occurrence and foreign ownership cannot consume it", async () => {
    const fixture = f!,
      ready = barrier<void>(),
      pids = new Set<number>();
    const results = await Promise.allSettled(Array.from({
      length: 8
    }, () => fixture.db.transaction().execute(async tx => {
      pids.add(await backendPid(tx));
      if (pids.size === 8) ready.resolve();
      await bounded(ready.promise);
      return createBotRoutinesRepository(tx).claim({
        ownerId: OWNER,
        routineId: fixture.routine.routineId,
        scheduledFor: PG_AT,
        nextFireAt: PG_NEXT,
        now: PG_AT
      });
    })));
    expect(pids.size).toBe(8);
    expect(results.filter(result => result.status === "rejected")).toEqual([]);
    const claimed = results.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
    expect(claimed).toHaveLength(1);
    expect(await fixture.repo.claim({
      ownerId: "foreign_owner",
      routineId: fixture.routine.routineId,
      scheduledFor: PG_NEXT,
      nextFireAt: null,
      now: PG_NEXT
    })).toBeUndefined();
    expect(await fixture.repo.fires("foreign_owner", fixture.routine.routineId)).toEqual([]);
    expect(await fixture.repo.fires(OWNER, fixture.routine.routineId)).toHaveLength(1);
  });

  // If dispatch ignores the committed pause or stops locking the same routine row, this must fail.
  it("pause committed by the lock holder fences an already-waiting dispatcher", async () => {
    const fixture = f!,
      fire = await fixture.claim();
    const dispatched = await behindRoutineLock(fixture, tx => createBotRoutinesRepository(tx).dispatch({
      ownerId: OWNER,
      fireId: fire.fireId,
      now: PG_AT
    }), async tx => {
      const repo = createBotRoutinesRepository(tx),
        current = (await repo.get(OWNER, fixture.routine.routineId))!;
      await repo.control({
        ownerId: OWNER,
        routineId: current.routineId,
        baseRevision: current.revision,
        status: "paused",
        now: PG_AT
      });
    });
    expect(dispatched).toBeUndefined();
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("claimed");
    expect((await fixture.tasks.get({
      ownerId: OWNER,
      taskId: fire.taskId
    }))?.status).toBe("queued");
  });
  it("dispatch winning the row lock does not lose a following revisioned pause", async () => {
    const fixture = f!,
      fire = await fixture.claim(),
      current = (await fixture.repo.get(OWNER, fixture.routine.routineId))!;
    const paused = await behindRoutineLock(fixture, tx => createBotRoutinesRepository(tx).control({
      ownerId: OWNER,
      routineId: current.routineId,
      baseRevision: current.revision,
      status: "paused",
      now: PG_AT
    }), tx => createBotRoutinesRepository(tx).dispatch({
      ownerId: OWNER,
      fireId: fire.fireId,
      now: PG_AT
    }));
    expect(paused.status).toBe("paused");
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.attempts).toBe(1);
    expect(await fixture.repo.pending(PG_AT)).toEqual([]);
    expect(await fixture.repo.due(PG_NEXT)).toEqual([]);
  });

  // Losing expectedStatus CAS must not close another scheduler's already running task.
  it("a stale claimed-only finalizer blocked behind dispatch cannot terminate the dispatched task", async () => {
    const fixture = f!,
      fire = await fixture.claim();
    const changed = await behindRoutineLock(fixture, tx => createBotRoutinesRepository(tx).finish({
      ownerId: OWNER,
      fireId: fire.fireId,
      expectedStatus: "claimed",
      status: "failed",
      failureCode: "background_not_authorized",
      now: PG_AT
    }), async tx => {
      await createBotRoutinesRepository(tx).dispatch({
        ownerId: OWNER,
        fireId: fire.fireId,
        now: PG_AT
      });
      const tasks = createBotTasksRepository(tx),
        task = (await tasks.get({
          ownerId: OWNER,
          taskId: fire.taskId
        }))!;
      await tasks.transition({
        ownerId: OWNER,
        taskId: fire.taskId,
        baseRevision: task.revision,
        to: "running",
        runId: "run_pg_dispatch_winner",
        now: PG_AT
      });
    });
    expect(changed).toBe(false);
    expect((await fixture.repo.getFire(OWNER, fire.fireId))?.status).toBe("dispatched");
    expect((await fixture.tasks.get({
      ownerId: OWNER,
      taskId: fire.taskId
    }))?.status).toBe("running");
    expect((await fixture.repo.get(OWNER, fixture.routine.routineId))?.status).toBe("active");
  });
  it("competing owner controls publish exactly one winning revision", async () => {
    const fixture = f!,
      before = await fixture.events(),
      baseRevision = fixture.routine.revision;
    const results = await Promise.allSettled(["paused", "archived"].map(status => fixture.execution().control(OWNER, BOT, fixture.routine.routineId, {
      baseRevision,
      status
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(result => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: {
        code: "revision_conflict"
      }
    });
    expect((await fixture.repo.get(OWNER, fixture.routine.routineId))?.revision).toBe(baseRevision + 1);
    expect((await fixture.events()).slice(before.length).map(event => event.event_type)).toEqual(["bot.authority.changed"]);
  });
  it("rolls back both owner control and its already-inserted outbox event when publication aborts", async () => {
    const fixture = f!,
      before = await fixture.events(),
      failure = new Error("synthetic outbox transaction abort");
    const aborting: BotStateTransactions = (ownerId, work) => fixture.transact(ownerId, tx => work({
      ...tx,
      publish: async (chatId, type, payload) => {
        await tx.publish(chatId, type, payload);
        throw failure;
      }
    }));
    await expect(fixture.execution(aborting).control(OWNER, BOT, fixture.routine.routineId, {
      baseRevision: fixture.routine.revision,
      status: "paused"
    })).rejects.toBe(failure);
    expect((await fixture.repo.get(OWNER, fixture.routine.routineId))?.status).toBe("active");
    expect((await fixture.repo.get(OWNER, fixture.routine.routineId))?.revision).toBe(1);
    expect(await fixture.events()).toEqual(before);
    expect(await fixture.db.selectFrom("chats").select("id").where("id", "=", PG_CHAT).execute()).toHaveLength(1);
  });
});
