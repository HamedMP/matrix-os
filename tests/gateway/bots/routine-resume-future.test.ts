import { expect, it } from "vitest";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { binding, data, proposal, setup } from "./routine-authorization-support.js";
import { NOW, OWNER } from "./bot-state-support.js";

it("resumes recurring work at a future slot instead of replaying time spent paused", async () => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  await context.interactions.resolve(OWNER, binding.chatId, pending.interactionId, { kind: "approval", decision: "approve", baseRevision: 1 });
  const [routine] = await context.repo.list(OWNER, binding.botId);
  let clock = routine.createdAt;
  const execution = createBotRoutineExecution({ db: data.db, approvals: context.service, now: () => new Date(clock) });
  const paused = await execution.control(OWNER, binding.botId, routine.routineId, { status: "paused", baseRevision: routine.revision });
  clock = new Date(Date.parse(clock) + 10 * 60000).toISOString();
  const resumed = await execution.control(OWNER, binding.botId, routine.routineId, { status: "active", baseRevision: paused.revision });
  expect(resumed.nextFireAt).toBe(new Date(Date.parse(clock) + 60000).toISOString());
  expect(await context.repo.due(clock)).toEqual([]);
  expect(await context.repo.fires(OWNER, routine.routineId)).toEqual([]);
});

it("keeps a paused one-time task paused when its approved time has passed", async () => {
  const context = setup(), at = new Date(Date.parse(NOW) + 60000).toISOString();
  const pending = await context.service.propose(binding, { ...proposal, schedule: { kind: "once", at } });
  await context.interactions.resolve(OWNER, binding.chatId, pending.interactionId, { kind: "approval", decision: "approve", baseRevision: 1 });
  const [routine] = await context.repo.list(OWNER, binding.botId);
  const paused = await context.repo.control({ ownerId: OWNER, routineId: routine.routineId, status: "paused", baseRevision: routine.revision, now: routine.createdAt });
  const execution = createBotRoutineExecution({ db: data.db, approvals: context.service, now: () => new Date(Date.parse(at) + 1000) });
  await expect(execution.control(OWNER, binding.botId, routine.routineId, { status: "active", baseRevision: paused.revision })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await context.repo.get(OWNER, routine.routineId)).toMatchObject({ status: "paused", revision: paused.revision });
});
