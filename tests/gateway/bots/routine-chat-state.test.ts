import { expect, it } from "vitest";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { CHAT, admitFixture, binding, data, proposal, setup } from "./routine-authorization-support.js";
import { NOW, OWNER } from "./bot-state-support.js";

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
