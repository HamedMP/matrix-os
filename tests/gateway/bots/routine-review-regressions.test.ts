import { BotRoutineProposalSchema, BotInteractionPayloadSchema } from "../../../packages/contracts/src/bots/index.js";
import { expect, it, vi } from "vitest";
import { CHAT, proposal, data, binding, setup, activated, admitFixture } from "./routine-authorization-support.js";
import { BOT, OWNER } from "./bot-state-support.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";

it.each(["x".repeat(4096), "中".repeat(4096), '"'.repeat(4096)])("preserves a maximum-length prompt through exact approval", async prompt => {
  const { service, interactions, repo } = setup();
  const pending = await service.propose(binding, { ...proposal, prompt });
  const record = (await createBotInteractionsRepository(data.db).get({ ownerId: OWNER, interactionId: pending.interactionId }))!;
  await interactions.resolve(OWNER, CHAT, pending.interactionId, { kind: "approval", decision: "approve", baseRevision: record.revision });
  expect((await repo.list(OWNER, BOT))[0].proposal.prompt).toBe(prompt);
});

it.each(["waiting_person", "completed"] as const)("reports saved waiting-person work as failed even when the worker reports %s", async status => {
  const { service, f, at, repo } = await activated();
  const input = await admitFixture(f.fireId), tasks = createBotTasksRepository(data.db);
  const task = (await tasks.get({ ownerId: OWNER, taskId: f.taskId }))!;
  await tasks.transition({ ownerId: OWNER, taskId: f.taskId, baseRevision: task.revision, to: "running", runId: input.runId, now: at });
  const execution = createBotRoutineExecution({ db: data.db, approvals: service, now: () => new Date(at) });
  if (status === "completed") await tasks.transition({ ownerId: OWNER, taskId: f.taskId, baseRevision: task.revision + 1, to: "waiting_person", now: at });
  expect(await execution.completeRun(input, { status })).toMatchObject({ status: "failed" });
  expect(await repo.getFire(OWNER, f.fireId)).toMatchObject({ status: "failed", failureCode: "human_action_required" });
});

it("rejects an unrepresentable escaped proposal at the tool schema and preserves ordinary approval limits", () => {
  expect(BotRoutineProposalSchema.safeParse({ ...proposal, prompt: "\u0001".repeat(4096) }).success).toBe(false);
  expect(BotInteractionPayloadSchema.safeParse({ kind: "approval", tool: "artifact.write", argsDigest: "a".repeat(64), audience: "direct", preview: "x".repeat(4097), policyRevision: 1 }).success).toBe(false);
});

it.each(["revoked", "start_throws", "no_state_unbound", "no_state_bound", "cancel_before_state"] as const)("settles a scheduled %s failure without leaving an uncertain occurrence", async failure => {
  const { service, resolve, f, r, at, repo } = await activated({ recurring: true });
  const identity = await admitFixture(f.fireId);
  const execution = createBotRoutineExecution({ db: data.db, approvals: service, now: () => new Date(at) });
  await execution.completeRun({ ...identity, owner: { type: "personal", ownerId: "foreign_fixture_owner" } }, { status: "failed" }, { beforeTaskState: true });
  expect(await repo.getFire(OWNER, f.fireId)).toMatchObject({ status: "dispatched" });
  if (failure === "revoked") resolve.mockRejectedValue(new Error("revoked fixture background consent"));
  const start = vi.fn(() => {
    if (failure === "start_throws") throw new Error("fixture setup failed");
    return { events: (async function* () {
      if (failure === "no_state_bound") {
    const tasks = createBotTasksRepository(data.db), task = (await tasks.get({ ownerId: OWNER, taskId: f.taskId }))!;
    await tasks.transition({ ownerId: OWNER, taskId: f.taskId, baseRevision: task.revision, to: "running", runId: identity.runId, now: at });
  }
    })(), result: Promise.resolve({ status: failure === "cancel_before_state" ? "cancelled" as const : "failed" as const }) };
  });
  const { createMatrixBotChatProviderAdapter } = await import("../../../packages/gateway/src/bots/chat-adapter.js");
  const adapter = createMatrixBotChatProviderAdapter({ orchestrator: { start, steer: vi.fn(), cancel: vi.fn(), abandon: vi.fn() } as never, stopRuntime: vi.fn(), routines: execution });
  const input = { ...identity, turnId: "cturn_routine_fixture", prompt: "fixture", parts: [{ type: "text" as const, text: "fixture" }], selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default", signal: new AbortController().signal };
  const events = [];
  for await (const event of adapter.start(input)) events.push(event);
  if (failure !== "cancel_before_state") expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed", error: { retryable: false, recoveryActions: [] } });
  if (failure === "revoked") expect(start).not.toHaveBeenCalled();
  expect(await repo.getFire(OWNER, f.fireId)).toMatchObject({ status: failure === "cancel_before_state" ? "cancelled" : "failed" });
  expect(await repo.get(OWNER, r.routineId)).toMatchObject({ status: failure === "cancel_before_state" ? "active" : "paused" });
});
