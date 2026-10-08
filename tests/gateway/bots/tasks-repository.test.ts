import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_TASK_MAX_DEPTH, createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
const base = { ownerId: OWNER, botId: BOT, chatId: "chat_tasks1" };

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_tasks1");
});
afterEach(async () => destroy());

describe("bot tasks repository", () => {
  it("moves through allowed transitions and counts only running time", async () => {
    const repo = createBotTasksRepository(db);
    const task = await repo.create({ ...base, now: NOW });
    expect(task).toMatchObject({ status: "queued", revision: 1, activeMs: 0, runningSince: null, budget: { depth: 0 } });
    const running = await repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 1, to: "running", runId: "run_first", now: at(0) });
    expect(running).toMatchObject({ status: "running", runId: "run_first", revision: 2 });
    const waiting = await repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 2, to: "waiting_person", now: at(4_000) });
    expect(waiting).toMatchObject({ status: "waiting_person", activeMs: 4_000, runningSince: null });
    // An hour of waiting for the person does not count.
    const resumed = await repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 3, to: "running", runId: "run_second", now: at(3_604_000) });
    const done = await repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: resumed.revision, to: "completed", now: at(3_606_500) });
    expect(done).toMatchObject({ status: "completed", activeMs: 6_500, runId: "run_second" });
    await expect(repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: done.revision, to: "running", now: at(3_607_000) }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
  });

  it("requires a reason to block, the current revision, and the same owner", async () => {
    const repo = createBotTasksRepository(db);
    const task = await repo.create({ ...base, now: NOW });
    await expect(repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 1, to: "blocked", now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
    const blocked = await repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 1, to: "blocked", blockedReason: "grant_revoked", now: NOW });
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "grant_revoked" });
    await expect(repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 1, to: "running", now: NOW }))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    await expect(repo.transition({ ownerId: OTHER_OWNER, taskId: task.taskId, baseRevision: 2, to: "running", now: NOW }))
      .rejects.toEqual(new BotStateError("not_found"));
    await expect(repo.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 2, to: "running", now: at(1) }))
      .resolves.toMatchObject({ status: "running", blockedReason: null });
  });

  it("cancels a task tree in one statement and caps child depth", async () => {
    const repo = createBotTasksRepository(db);
    const root = await repo.create({ ...base, now: NOW });
    await repo.transition({ ownerId: OWNER, taskId: root.taskId, baseRevision: 1, to: "running", now: NOW });
    let parent = root.taskId;
    const chain = [root.taskId];
    for (let depth = 1; depth <= BOT_TASK_MAX_DEPTH; depth += 1) {
      const child = await repo.create({ ...base, parentTaskId: parent, now: at(depth) });
      expect(child.budget.depth).toBe(depth);
      chain.push(child.taskId);
      parent = child.taskId;
    }
    await expect(repo.create({ ...base, parentTaskId: parent, now: NOW })).rejects.toEqual(new BotStateError("capacity_exceeded"));
    const done = await repo.transition({ ownerId: OWNER, taskId: chain[1]!, baseRevision: 1, to: "failed", now: NOW });
    expect(done.status).toBe("failed");

    const cancelled = await repo.cancelTree({ ownerId: OWNER, taskId: root.taskId, now: at(5_000) });
    expect(cancelled.sort()).toEqual([chain[0]!, chain[2]!, chain[3]!].sort());
    await expect(repo.get({ ownerId: OWNER, taskId: chain[1]! })).resolves.toMatchObject({ status: "failed" });
    await expect(repo.get({ ownerId: OWNER, taskId: root.taskId })).resolves.toMatchObject({ status: "cancelled", activeMs: 5_000 });
    await expect(repo.create({ ...base, parentTaskId: root.taskId, now: NOW })).rejects.toEqual(new BotStateError("not_found"));
    await expect(repo.cancelTree({ ownerId: OTHER_OWNER, taskId: root.taskId, now: NOW })).resolves.toEqual([]);
    await expect(repo.listOpen(base)).resolves.toEqual([]);
  });

  it("refuses a task in a chat the owner does not own", async () => {
    await insertChat(db, "chat_foreign3", OTHER_OWNER);
    await expect(createBotTasksRepository(db).create({ ...base, chatId: "chat_foreign3", now: NOW }))
      .rejects.toEqual(new BotStateError("not_found"));
  });
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("bot tasks repository on pooled Postgres", () => {
  it("cancels a child that a concurrent create inserted while holding the parent lock", async () => {
    const real = await createRealBotStateDatabase();
    try {
      await insertChat(real.db, "chat_tasks1");
      const repo = createBotTasksRepository(real.db);
      const root = await repo.create({ ...base, now: NOW });
      let childInserted!: () => void;
      const inserted = new Promise<void>((resolve) => { childInserted = resolve; });
      let releaseCreate!: () => void;
      const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
      // Holds the parent row lock with the child inserted but not yet committed.
      const create = real.db.transaction().execute(async (trx) => {
        const child = await repo.create({ ...base, parentTaskId: root.taskId, now: at(1) }, trx);
        childInserted();
        await release;
        return child;
      });
      await inserted;
      const cancelling = repo.cancelTree({ ownerId: OWNER, taskId: root.taskId, now: at(2) });
      await new Promise((resolve) => setTimeout(resolve, 200));
      releaseCreate();
      const child = await create;
      const cancelled = await cancelling;
      expect(cancelled.sort()).toEqual([root.taskId, child.taskId].sort());
      await expect(repo.get({ ownerId: OWNER, taskId: child.taskId })).resolves.toMatchObject({ status: "cancelled" });
    } finally {
      await real.destroy();
    }
  }, 60_000);
});
