import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBotStateDatabase, OWNER, BOT, NOW, at } from "./bot-state-support.js";
import { canonicalFixture, runningCanonicalFire } from "./routine-cli-canonical-support.js";
import { insertChat } from "./bot-state-support.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { insertFire, TARGET_A, TARGET_B } from "./routine-cli-request-support.js";
import { createRoutineCliCanonicalControl } from "../../../packages/gateway/src/bots/routine-cli-canonical-control.js";
let db: Awaited<ReturnType<typeof createBotStateDatabase>>, f: Awaited<ReturnType<typeof canonicalFixture>>;
beforeEach(async () => { db = await createBotStateDatabase(); f = await canonicalFixture(db.db); });
afterEach(async () => { await f?.close(); await db?.destroy(); });
it("uses real canonical approval/control/outbox for resume, pause and archive", async () => {
  expect(await f.control("resume")).toMatchObject({ receipt: { disposition: "applied", routine: { status: "active", revision: 2 } } });
  expect(await f.control("pause", 2, 101)).toMatchObject({ receipt: { routine: { status: "paused", revision: 3 } }, execution: { stop: "unconfirmed" } });
  expect(await f.control("archive", 3, 102)).toMatchObject({ receipt: { routine: { status: "archived", revision: 4 } }, execution: { stop: "unconfirmed" } });
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(3);
  expect((await f.execute({ operation: "show", routineId: f.id })).kind).toBe("show");
  await expect(f.control("resume", 4, 103)).rejects.toMatchObject({ code: "invalid_input" });
});
it.each(["background", "accountId", "computerId", "grantRevision", "definitionRevision", "approval"] as const)("fails real canonical resume policy for changed %s", async key => {
  if (key === "background") f.policy.background = false;
  else if (key === "accountId" || key === "computerId") f.policy[key] = "changed";
  else if (key === "approval") await f.db.updateTable("bot_approvals").set({ status: "denied" }).execute();
  else f.policy[key]++;
  await expect(f.control("resume")).rejects.toMatchObject({ code: "invalid_input" });
  expect((await f.repo.get(OWNER, f.id))!.revision).toBe(1);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
});
it("rejects stale revision and old uncertain history beyond latest20", async () => {
  await expect(f.control("pause", 2)).rejects.toMatchObject({ code: "revision_conflict" });
  for (let n = 1; n <= 22; n++) await insertFire(f.db, f.id, n, n === 1 ? "uncertain" : "completed");
  await expect(f.control("resume")).rejects.toMatchObject({ code: "invalid_input" });
  expect(await f.execute({ operation: "show", routineId: f.id })).toMatchObject({ routine: { requiresReview: true }, history: { truncated: true } });
});
it("fails closed for proposal and validates adapter dependencies on construction", async () => {
  expect(() => createRoutineCliCanonicalControl({ control: {} as never })).toThrow();
  const { propose } = await import("./routine-cli-request-support.js");
  expect(await f.execute(propose(), f.adapter)).toMatchObject({ kind: "unknown" });
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
});
it("does not cancel on duplicate or receipt reconciliation after a default switch", async () => {
  const after = vi.fn<NonNullable<typeof f.adapter.afterMutationCommit>>(async () => undefined), ports = { ...f.adapter, afterMutationCommit: after };
  const operation = f.operation("pause"), original = await f.execute(operation, ports);
  await f.switchDefault();
  expect(await f.execute(operation, ports)).toEqual(original);
  expect(await f.execute({ operation: "request", requestId: operation.requestId }, ports)).toEqual(original);
  expect(after).toHaveBeenCalledTimes(1);
  expect(after.mock.calls[0]?.[0]).toMatchObject({ operation, target: TARGET_A });
  expect(after.mock.calls[0]?.[0]).not.toHaveProperty("transaction");
});
it("retains known applied state when postcommit cancellation throws", async () => {
  const result = await f.execute(f.operation("pause"), { ...f.adapter, afterMutationCommit: async () => { throw new Error("Fixture cancellation transport failed"); } });
  expect(result).toMatchObject({ receipt: { disposition: "applied", routine: { revision: 2 } }, execution: { stop: "unconfirmed" } });
  expect((await f.repo.get(OWNER, f.id))!.status).toBe("paused");
});
it("does not let a delayed pause cancel a fire claimed after a newer canonical resume", async () => {
  let laterFireId: string | undefined;
  const result = await f.execute(f.operation("pause"), { ...f.adapter, afterMutationCommit: async intent => {
    // The old pause has committed, but its external phase has not selected work yet.
    await f.execution.control(OWNER, BOT, f.id, { status: "active", baseRevision: 2 });
    const later = await f.repo.claim({ ownerId: OWNER, routineId: f.id, scheduledFor: at(60_000),
      nextFireAt: at(120_000), now: at(60_000) });
    expect(later).toBeDefined(); laterFireId = later!.fireId;
    await f.adapter.afterMutationCommit(intent);
  } });
  expect(result).toMatchObject({ receipt: { disposition: "applied", routine: { status: "paused", revision: 2 } },
    execution: { stop: "unconfirmed" } });
  expect(await f.repo.get(OWNER, f.id)).toMatchObject({ status: "active" });
  expect(await f.repo.getFire(OWNER, laterFireId!)).toMatchObject({ status: "claimed" });
});
it("does not redrive cancellation on a lost durable commit acknowledgement", async () => {
  const after = vi.fn(async () => undefined);
  const result = await f.execute(f.operation("pause"), { ...f.adapter, afterMutationCommit: after,
    transact: async (owner, work) => { await f.transact(owner, work); throw new Error("Fixture lost commit acknowledgement"); } });
  expect(result).toMatchObject({ kind: "unknown" });
  expect((await f.repo.get(OWNER, f.id))!.revision).toBe(2);
  expect(after).not.toHaveBeenCalled();
  expect(await f.execute({ operation: "request", requestId: f.operation("pause").requestId }, { ...f.adapter, afterMutationCommit: after })).toMatchObject({ receipt: { disposition: "applied" }, execution: { stop: "unconfirmed" } });
  expect(after).not.toHaveBeenCalled();
});
it.each(["foreign owner", "foreign Bot", "same Bot different Chat", "target permission"] as const)("rejects %s before canonical control", async kind => {
  if (kind === "target permission") f.state.targetAllowed = false;
  else if (kind === "foreign owner") {
    await insertChat(f.db, "chat_foreign", "user_foreign");
    await createBotBindingsRepository(f.db).bindDirect({ ownerId: "user_foreign", botId: BOT, chatId: "chat_foreign", now: NOW });
    await f.db.updateTable("bot_routines").set({ owner_id: "user_foreign", chat_id: "chat_foreign" }).where("routine_id", "=", f.id).execute();
  } else if (kind === "foreign Bot") await f.db.updateTable("bot_routines").set({ bot_id: TARGET_B.botId, chat_id: TARGET_B.chatId }).where("routine_id", "=", f.id).execute();
  else {
    await f.db.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: BOT, chat_id: TARGET_B.chatId, kind: "direct", created_at: NOW, removed_at: NOW }).execute();
    await f.db.updateTable("bot_routines").set({ chat_id: TARGET_B.chatId }).where("routine_id", "=", f.id).execute();
  }
  await expect(f.control("pause")).rejects.toMatchObject({ code: kind === "target permission" ? "permission_denied" : "not_found" });
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
});
it.each(["lifecycle", "operation"] as const)("rolls back ACTUAL canonical control/outbox/receipt/consumption after final %s denial", async boundary => {
  const running = await runningCanonicalFire(f), cancel = vi.fn(async () => undefined);
  f.execution.connect({ repository: f.chats, orchestrator: { cancelRun: cancel } } as never);
  const after = vi.fn(f.adapter.afterMutationCommit); let witnessed = false;
  await expect(f.execute(f.operation("pause", running.revision), { ...f.adapter, afterMutationCommit: after,
    sources: { consumeWithin: (trx, input, work) => f.sources.consumeWithin(trx, input, async (source, executor, invocation) => {
      const result = await work(source, executor, invocation);
      expect((await f.repo.get(OWNER, f.id, trx))!).toMatchObject({ status: "paused", revision: running.revision + 1 });
      expect(await trx.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
      expect(await trx.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(1);
      expect((await trx.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).not.toBeNull();
      witnessed = true;
      if (boundary === "lifecycle") f.state.live = false; else f.state.operationAllowed = false;
      return result;
    }) } })).rejects.toMatchObject({ code: "permission_denied" });
  expect(witnessed).toBe(true); expect(after).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  expect((await f.repo.get(OWNER, f.id))!).toMatchObject({ status: "active", revision: running.revision });
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(0);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).toBeNull();
});

it.each(["worker exit unobserved", "external effect unknown"] as const)("keeps cancellation ACK unconfirmed when %s", async kind => {
  const running = await runningCanonicalFire(f);
  if (kind === "external effect unknown") {
    const { createBotCheckpointsRepository } = await import("../../../packages/gateway/src/bots/repositories/checkpoints.js");
    const checkpoints = createBotCheckpointsRepository(f.db), { checkpoint } = await checkpoints.prepare({ ownerId: OWNER,
      taskId: running.fire.taskId, runId: running.runId, toolCallId: "call_unknown", action: { capability: "integration.call" }, effectClass: "write", now: NOW });
    await checkpoints.markDispatched({ ownerId: OWNER, checkpointId: checkpoint.checkpointId, now: NOW });
  }
  const cancelRun = vi.fn(async () => {
    if (kind === "external effect unknown") {
      const task = (await running.tasks.get({ ownerId: OWNER, taskId: running.fire.taskId }))!;
      await running.tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision, to: "cancelled", now: NOW });
    }
  });
  f.execution.connect({ repository: f.chats, orchestrator: { cancelRun } } as never);
  const result = await f.control("pause", running.revision);
  expect(result).toMatchObject({ receipt: { disposition: "applied", routine: { status: "paused" } }, execution: { stop: "unconfirmed" } });
  expect(cancelRun).toHaveBeenCalledTimes(1);
  expect(await f.repo.getFire(OWNER, running.fire.fireId)).toMatchObject({ status: "uncertain" });
  expect(await f.execute({ operation: "show", routineId: f.id })).toMatchObject({ routine: { requiresReview: true, lastFire: { status: "uncertain" } } });
});
it("cancels all active fire pages rather than only the newest display or first32", async () => {
  for (let n = 1; n <= 35; n++) await insertFire(f.db, f.id, n, "completed");
  await f.db.updateTable("bot_routine_fires").set({ status: "claimed" }).where("routine_id", "=", f.id).execute();
  expect(await f.control("pause")).toMatchObject({ receipt: { disposition: "applied" }, execution: { stop: "unconfirmed" } });
  const fires = await f.db.selectFrom("bot_routine_fires").select("status").where("routine_id", "=", f.id).execute();
  expect(fires).toHaveLength(35); expect(fires.every(fire => fire.status === "cancelled")).toBe(true);
});
