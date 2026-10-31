import { expect, it } from "vitest";
import { activated, data, CHAT } from "./routine-authorization-support.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BOT, OWNER } from "./bot-state-support.js";

it.each(["uncertain", "dispatched"] as const)("uses full fire history for %s beyond the display page", async status => {
  const { createBotRoutineExecution } = await import("../../../packages/gateway/src/bots/routine-execution.js");
  const { service, r, f, at, repo } = await activated();
  await data.db.updateTable("bot_routine_fires").set({ status }).where("fire_id", "=", f.fireId).execute();
  const original = await data.db.selectFrom("bot_routine_fires").selectAll().where("fire_id", "=", f.fireId).executeTakeFirstOrThrow();
  for (let i = 1; i <= 21; i++) {
    const task = await createBotTasksRepository(data.db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: at });
    await data.db.insertInto("bot_routine_fires").values({ ...original, fire_id: `fire_${i.toString(16).padStart(24, "0")}`, task_id: task.taskId,
      scheduled_for: new Date(Date.parse(at) + i * 1000).toISOString(), status: "completed" }).execute();
  }
  expect((await repo.fires(OWNER, r.routineId)).every(fire => fire.status === "completed")).toBe(true);
  const execution = createBotRoutineExecution({ db: data.db, approvals: service, now: () => new Date(at) });
  const revision = (await repo.get(OWNER, r.routineId))!.revision;
  if (status === "uncertain") {
    await expect(execution.control(OWNER, BOT, r.routineId, { status: "active", baseRevision: revision })).rejects.toMatchObject({ code: "conflict" });
    expect((await execution.list(OWNER, BOT))[0].requiresReview).toBe(true);
  } else {
    await execution.control(OWNER, BOT, r.routineId, { status: "paused", baseRevision: revision });
    expect((await repo.getFire(OWNER, f.fireId))!.status).toBe("cancelled");
  }
});
