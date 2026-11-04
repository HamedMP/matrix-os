import { expect, it } from "vitest";
import { CHAT, data, activated, admitFixture } from "./routine-authorization-support.js";
import { OWNER } from "./bot-state-support.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";

it("retries only proven pre-worker capacity, with a bounded durable fire and exact attempt fencing", async () => {
  const {
    createBotRoutineExecution
  } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const {
      service,
      r,
      f,
      at,
      repo
    } = await activated();
  let input = await admitFixture(f.fireId);
  let clock = at;
  const execution = createBotRoutineExecution({
      db: data.db,
      approvals: service,
      now: () => new Date(clock)
    }),
    tasks = createBotTasksRepository(data.db);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      clock = new Date(Date.parse(clock) + 60_000).toISOString();
      await repo.dispatch({
        ownerId: OWNER,
        fireId: f.fireId,
        now: clock
      });
      await input.repository.finishRun(input.owner, { chatId: CHAT, runId: input.runId, outcome: "failed", completedAt: clock });
      input = await admitFixture(f.fireId, `req_routine_${f.fireId}_a${attempt}`, `_a${attempt}`);
    }
    expect((await execution.prepareRun(input))?.backgroundTaskId).toBe(f.taskId);
    const task = (await tasks.get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
    await tasks.transition({
      ownerId: OWNER,
      taskId: f.taskId,
      baseRevision: task.revision,
      to: "running",
      runId: input.runId,
      now: clock
    });
    const running = (await tasks.get({
      ownerId: OWNER,
      taskId: f.taskId
    }))!;
    await tasks.transition({
      ownerId: OWNER,
      taskId: f.taskId,
      baseRevision: running.revision,
      to: "blocked",
      blockedReason: "capacity_unavailable",
      now: clock
    });
    await execution.completeRun(input, {
      status: "blocked",
      blockedReason: "capacity_unavailable",
      retryableBeforeDispatch: true
    });
    const fire = (await repo.getFire(OWNER, f.fireId))!;
    expect(fire).toMatchObject({
      attempts: attempt,
      status: attempt < 3 ? "claimed" : "failed",
      failureCode: attempt < 3 ? "capacity_unavailable" : "capacity_exhausted"
    });
    expect((await repo.get(OWNER, r.routineId))?.status).toBe(attempt < 3 ? "active" : "paused");
    if (attempt < 3) expect(Date.parse(fire.retryAfter!)).toBe(Date.parse(clock) + 30_000 * attempt);
  }
  expect(await data.db.selectFrom("bot_tasks").select("task_id").where("task_id", "=", f.taskId).execute()).toHaveLength(1);
});
