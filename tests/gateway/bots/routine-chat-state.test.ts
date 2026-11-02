import { expect, it } from "vitest";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { CHAT, admitFixture, binding, data, proposal, setup } from "./routine-authorization-support.js";
import { NOW, OWNER } from "./bot-state-support.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";

it("reports the persisted approval transition in ordinary Chat without treating user text as authority", async () => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  const execution = createBotRoutineExecution({ db: data.db, approvals: context.service, now: () => new Date(NOW) });
  const read = () => execution.describeChatPhase(binding);
  expect(await read()).toContain('"pending":1');
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {kind: "approval", decision: "approve", baseRevision: 1});
  const phase = await read();
  expect(phase).toContain('"active":1'); expect(phase).toContain('"pending":0');
  expect(phase).toContain("does not authorize execution");
  const [routine] = await context.repo.list(OWNER, binding.botId);
  await execution.control(OWNER, binding.botId, routine.routineId, {status: "paused", baseRevision: routine.revision});
  expect(await read()).toContain('"paused":1');
  expect(await execution.describeChatPhase({...binding, ownerId: "foreign"})).toBeNull();
  expect(await execution.describeChatPhase({...binding, runId: "forged"})).toBeNull();
});


it("identifies the exact persisted resolved approval for its admitted continuation even when history says pending", async () => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {kind: "approval", decision: "approve", baseRevision: 1});
  const input = await admitFixture("unused", `req_answer_${pending.interactionId}`);
  await data.db.updateTable("bot_tasks").set({run_id: input.runId}).where("task_id", "=", binding.taskId).execute();
  const execution = createBotRoutineExecution({db: data.db, approvals: context.service, now: () => new Date(NOW)});
  const phase = await execution.describeChatPhase({...binding, runId: input.runId});
  expect(phase).toContain('"resolvedApproval":"approved"');
  expect(phase).toContain('"pending":0');
});

it.each(["approved", "denied"] as const)("acknowledges a persisted %s decision without granting execution", async decision => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {kind: "approval", decision: decision === "approved" ? "approve" : "deny", baseRevision: 1});
  const input = await admitFixture("unused", `req_answer_${pending.interactionId}`);
  await data.db.updateTable("bot_tasks").set({run_id: input.runId}).where("task_id", "=", binding.taskId).execute();
  const execution = createBotRoutineExecution({db: data.db, approvals: context.service, now: () => new Date(NOW)});
  const scope = {...binding, runId: input.runId};
  expect(await execution.approvalReply(scope)).toBe(decision === "approved"
    ? "Your schedule approval was recorded. Open Schedules to see its current status and next run."
    : "Your schedule request was declined. Existing schedules are unchanged.");
  for (const field of ["ownerId", "botId", "chatId", "taskId", "runId"] as const)
    expect(await execution.approvalReply({...scope, [field]: "foreign"})).toBeNull();
  if (decision === "approved") {
    await data.db.updateTable("bot_routines").set({status: "archived"}).where("owner_id", "=", OWNER).execute();
    expect(await execution.approvalReply(scope)).not.toMatch(/is active|running|activated/);
  }
});

it.each(["unclaimed", "expired", "changed_digest", "unrelated_tool", "task_cancelled", "shared_chat"] as const)("refuses a schedule receipt after %s", async change => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {kind: "approval", decision: "approve", baseRevision: 1});
  const input = await admitFixture("unused", `req_answer_${pending.interactionId}`);
  await data.db.updateTable("bot_tasks").set({run_id: input.runId}).where("task_id", "=", binding.taskId).execute();
  if (change === "unclaimed") await data.db.updateTable("bot_approvals").set({claimed_at: null}).where("approval_id", "=", pending.interactionId).execute();
  if (change === "changed_digest") await data.db.updateTable("bot_approvals").set({args_hash: "f".repeat(64)}).where("approval_id", "=", pending.interactionId).execute();
  if (change === "unrelated_tool") await data.db.updateTable("bot_approvals").set({tool: "integration.call"}).where("approval_id", "=", pending.interactionId).execute();
  if (change === "expired") await data.db.updateTable("bot_interactions").set({expires_at: new Date(Date.parse(NOW) + 1000).toISOString()}).where("interaction_id", "=", pending.interactionId).execute();
  if (change === "task_cancelled") {
    const tasks = createBotTasksRepository(data.db), task = (await tasks.get({ownerId: OWNER, taskId: binding.taskId}))!;
    await tasks.transition({ownerId: OWNER, taskId: binding.taskId, baseRevision: task.revision, to: "cancelled", now: NOW});
  }
  if (change === "shared_chat") await data.db.updateTable("chats").set({collaboration: JSON.stringify({shared: true}) as never}).where("id", "=", CHAT).execute();
  const execution = createBotRoutineExecution({db: data.db, approvals: context.service, now: () => new Date(Date.parse(NOW) + (change === "expired" ? 2000 : 0))});
  expect(await execution.approvalReply({...binding, runId: input.runId})).toBeNull();
});
