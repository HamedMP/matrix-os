import { expect, it, vi } from "vitest";
import { CHAT, proposal, data, binding, activated, admitFixture } from "./routine-authorization-support.js";
import { BOT, OWNER } from "./bot-state-support.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";

it.each(["restart", "running"] as const)("reconciles ordinary queued-turn cancellation on %s before lease expiry without touching the foreground run", async mode => {
  const { service, f, r, at, repo } = await activated({ recurring: true });
  const foreground = await admitFixture("foreground_fixture", "req_foreground_fixture");
  const chats = foreground.repository, owner = foreground.owner;
  await chats.enqueueQueuedTurn(owner, {
    chatId: CHAT, baseRevision: (await chats.get(owner, CHAT))!.chat.revision,
    queuedTurnId: "qturn_routine_cancel_review", clientRequestId: `req_routine_${f.fireId}`,
    parts: [{ type: "text", text: proposal.prompt }], selection: { instanceId: "matrix_bot_default", model: "auto" },
    driverKind: "matrix_bot", interactionMode: "default", permissionMode: "default", createdAt: at,
    capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true,
      userInput: true, resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["default"] },
  });
  const execution = createBotRoutineExecution({ db: data.db, approvals: service, now: () => new Date(at) });
  if (mode === "running") vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    if (mode === "running") await execution.start({ repository: chats, orchestrator: {} } as never);
    await chats.cancelQueuedTurn(owner, { chatId: CHAT, queuedTurnId: "qturn_routine_cancel_review", clientRequestId: "req_cancel_review",
      baseRevision: (await chats.get(owner, CHAT))!.chat.revision, cancelledAt: at });
    if (mode === "restart") await execution.start({ repository: chats, orchestrator: {} } as never);
    else await vi.advanceTimersByTimeAsync(15000);
    await expect.poll(async () => (await repo.getFire(OWNER, f.fireId))?.status).toBe("cancelled");
  } finally { await execution.stop(); if (mode === "running") vi.useRealTimers(); }
  expect(await repo.getFire(OWNER, f.fireId)).toMatchObject({ status: "cancelled" });
  expect(await repo.get(OWNER, r.routineId)).toMatchObject({ status: "active" });
  expect((await createBotTasksRepository(data.db).get({ ownerId: OWNER, taskId: f.taskId }))?.status).toBe("cancelled");
  expect((await chats.exportChat(owner, CHAT))!.runs.find(run => run.id === foreground.runId)?.status).toBe("accepted");
  const before = await data.db.selectFrom("chat_outbox").select("cursor").execute();
  const restarted = createBotRoutineExecution({ db: data.db, approvals: service, now: () => new Date(at) });
  try { await restarted.start({ repository: chats, orchestrator: {} } as never); } finally { await restarted.stop(); }
  expect(await data.db.selectFrom("chat_outbox").select("cursor").execute()).toHaveLength(before.length);
});

it("cancels a finished scheduled task's pending question and announces its final revision once", async () => {
  const { service, f, at } = await activated(), input = await admitFixture(f.fireId);
  const tasks = createBotTasksRepository(data.db), task = (await tasks.get({ ownerId: OWNER, taskId: f.taskId }))!;
  await tasks.transition({ ownerId: OWNER, taskId: f.taskId, baseRevision: task.revision, to: "running", runId: input.runId, now: at });
  const interactions = createBotInteractionsRepository(data.db);
  const payload = { kind: "question", questions: [{ questionId: "q1", header: "Choice", question: "Which fixture?", allowOther: true, secret: false }] };
  const expiresAt = new Date(Date.parse(at) + 60000).toISOString();
  const pending = (await interactions.create({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: f.taskId, kind: "question", payload,
    responderActorId: OWNER, blocking: true, sourceRunId: input.runId, expiresAt, now: at })).interaction;
  const unrelated = (await interactions.create({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: binding.taskId, kind: "question", payload,
    responderActorId: OWNER, blocking: true, sourceRunId: binding.runId, expiresAt, now: at })).interaction;
  await tasks.transition({ ownerId: OWNER, taskId: f.taskId, baseRevision: task.revision + 1, to: "waiting_person", now: at });
  const execution = createBotRoutineExecution({ db: data.db, approvals: service, now: () => new Date(at) });
  await execution.completeRun(input, { status: "waiting_person" });
  expect(await interactions.get({ ownerId: OWNER, interactionId: pending.interactionId })).toMatchObject({ status: "cancelled", revision: pending.revision + 1 });
  expect((await interactions.listPending({ ownerId: OWNER, chatId: CHAT, now: at })).map(row => row.interactionId)).toEqual([unrelated.interactionId]);
  const events = () => data.db.selectFrom("chat_outbox").select("payload").where("event_type", "=", "interaction.resolved").execute();
  const resolved = (await events()).filter(row => (row.payload as Record<string, unknown>).interactionId === pending.interactionId);
  expect(resolved).toHaveLength(1);
  expect(resolved[0].payload).toMatchObject({ status: "cancelled", revision: pending.revision + 1 });
  await execution.completeRun(input, { status: "waiting_person" });
  expect((await events()).filter(row => (row.payload as Record<string, unknown>).interactionId === pending.interactionId)).toHaveLength(1);
});

it.each([{ label: "11 minutes", minutes: 11, recover: true }, { label: "13 minutes after recovery", minutes: 13, recover: true }, { label: "13 minutes claimed before recovery", minutes: 13, recover: false }])("gives a queued occurrence a full execution lease after $label", async ({ minutes, recover }) => {
  const { service, f, at, repo } = await activated({ recurring: true });
  const foreground = await admitFixture("foreground_lease_fixture", "req_foreground_lease_fixture");
  const chats = foreground.repository, owner = foreground.owner;
  await chats.enqueueQueuedTurn(owner, {
    chatId: CHAT, baseRevision: (await chats.get(owner, CHAT))!.chat.revision,
    queuedTurnId: "qturn_routine_lease_review", clientRequestId: `req_routine_${f.fireId}`,
    parts: [{ type: "text", text: proposal.prompt }], selection: { instanceId: "matrix_bot_default", model: "auto" },
    driverKind: "matrix_bot", interactionMode: "default", permissionMode: "default", createdAt: at,
    capabilitySnapshot: { revision: "fixture", rootChat: true, attachments: [], resources: [], tools: [], approvals: true,
      userInput: true, resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["default"] },
  });
  const later = new Date(Date.parse(at) + minutes * 60000).toISOString();
  let clock = later;
  const execution = createBotRoutineExecution({ db: data.db, approvals: service, now: () => new Date(clock) });
  try {
    if (recover) await execution.start({ repository: chats, orchestrator: {} } as never);
    expect(await repo.getFire(OWNER, f.fireId)).toMatchObject({ status: "dispatched" });
    if (recover) expect(Date.parse((await repo.getFire(OWNER, f.fireId))!.leaseExpiresAt!)).toBeGreaterThan(Date.parse(later));
    await chats.finishRun(owner, { chatId: CHAT, runId: foreground.runId, outcome: "completed", completedAt: later });
    const claimed = (await chats.claimNextQueuedTurn(owner, { chatId: CHAT, runId: "run_claimed_lease_fixture", turnId: "cturn_claimed_lease_fixture", messageId: "msg_claimed_lease_fixture", claimedAt: later }))!;
    expect(claimed).toBeDefined();
    expect(await execution.prepareRun({ owner, chatId: CHAT, runId: claimed.run.id })).toMatchObject({ backgroundTaskId: f.taskId, text: proposal.prompt });
    expect(Date.parse((await repo.getFire(OWNER, f.fireId))!.leaseExpiresAt!)).toBe(Date.parse(later) + 12 * 60000);
    const tasks = createBotTasksRepository(data.db), task = (await tasks.get({ ownerId: OWNER, taskId: f.taskId }))!;
    await tasks.transition({ ownerId: OWNER, taskId: f.taskId, baseRevision: task.revision, to: "running", runId: claimed.run.id, now: later });
    clock = new Date(Date.parse(later) + 2 * 60000).toISOString();
    await expect(execution.assertBinding({ ...binding, taskId: f.taskId, runId: claimed.run.id, requestClass: "background" })).resolves.toBeDefined();
  } finally { await execution.stop(); }
});
