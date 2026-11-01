import { expect, it } from "vitest";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { CHAT, binding, data, proposal, setup } from "./routine-authorization-support.js";
import { OWNER } from "./bot-state-support.js";

it("lists pending and approved personal schedules through one owner-scoped HTTP entry and provides their history", async () => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  const routines = createBotRoutineExecution({ db: data.db, approvals: context.service });
  const app = (owner: string) => createBotRoutes({ routines, getPrincipal: () => ({ userId: owner, source: "jwt" }) });
  let response = await app(OWNER).request("/api/bot-routines");
  expect(response.status).toBe(200);
  const pendingPage = await response.json();
  expect(pendingPage).toMatchObject({ items: [], pending: [{ interactionId: pending.interactionId }], nextCursor: null });
  expect(JSON.parse(pendingPage.pending[0].payload.preview).estimatedNextFireAt).toMatch(/^\d{4}-/);
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, { kind: "approval", decision: "approve", baseRevision: 1 });
  response = await app(OWNER).request("/api/bot-routines");
  const page = await response.json();
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ proposal, targetAvailable: true, computerId: "fixture-computer", status: "active" });
  expect(page.pending).toEqual([]);
  expect(await (await app("foreign").request("/api/bot-routines")).json()).toMatchObject({ items: [], pending: [] });
  expect((await app("foreign").request(`/api/bot-routines/${page.items[0].routineId}`)).status).toBe(404);
  expect(await (await app(OWNER).request(`/api/bot-routines/${page.items[0].routineId}`)).json()).toMatchObject({ history: [] });
});

it("reviews edits without applying them, deduplicates retry, then changes only the approved routine at its revision", async () => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, { kind: "approval", decision: "approve", baseRevision: 1 });
  const [original] = await context.repo.list(OWNER, binding.botId);
  const routines = createBotRoutineExecution({ db: data.db, approvals: context.service });
  const app = createBotRoutes({ routines, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) });
  const request = { baseRevision: original.revision, name: "Revised brief", prompt: "Write a revised private brief", schedule: { kind: "interval", everyMs: 120000 } };
  const review = () => app.request(`/api/bot-routines/${original.routineId}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  const response = await review();
  expect(response.status).toBe(200);
  const first = await response.json(), second = await (await review()).json();
  expect(first.interaction.interactionId).toBe(second.interaction.interactionId);
  expect(first.interaction.blocking).toBe(false);
  expect((await context.repo.get(OWNER, original.routineId))!.proposal).toEqual(proposal);
  await context.interactions.resolve(OWNER, CHAT, first.interaction.interactionId, { kind: "approval", decision: "approve", baseRevision: 1 });
  const saved = await context.repo.list(OWNER, binding.botId);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ routineId: original.routineId, revision: original.revision + 1, status: "active",
    proposal: { name: request.name, prompt: request.prompt, schedule: request.schedule, selection: proposal.selection, authorizedEffects: ["read"] } });
  expect(saved[0].approvalId).not.toBe(original.approvalId);
  expect(await context.service.authorize(saved[0])).toBe(true);
  expect((await review()).status).toBe(409);
});

it("denies an edit without changing the old approval and preserves a paused lifecycle when a later edit is approved", async () => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {kind: "approval", decision: "approve", baseRevision: 1});
  const execution = createBotRoutineExecution({db: data.db, approvals: context.service});
  const [original] = await context.repo.list(OWNER, binding.botId);
  const request = {baseRevision: original.revision, name: "Revised brief", prompt: "Only revised fixture text", schedule: {kind: "interval", everyMs: 120000}};
  const first = await execution.requestEdit(OWNER, original.routineId, request);
  await context.interactions.resolve(OWNER, CHAT, first.interaction.interactionId, {kind: "approval", decision: "deny", baseRevision: 1});
  expect(await context.repo.get(OWNER, original.routineId)).toMatchObject({proposal, approvalId: original.approvalId, revision: original.revision});
  const paused = await execution.control(OWNER, binding.botId, original.routineId, {status: "paused", baseRevision: original.revision});
  const second = await execution.requestEdit(OWNER, original.routineId, {...request, baseRevision: paused.revision});
  await context.interactions.resolve(OWNER, CHAT, second.interaction.interactionId, {kind: "approval", decision: "approve", baseRevision: 1});
  expect(await context.repo.get(OWNER, original.routineId)).toMatchObject({status: "paused", proposal: {name: request.name}, revision: paused.revision + 1});
  await expect(execution.requestEdit("foreign", original.routineId, request)).rejects.toMatchObject({code: "not_found"});
  const current = (await context.repo.get(OWNER, original.routineId))!;
  await execution.control(OWNER, binding.botId, current.routineId, {status: "archived", baseRevision: current.revision});
  expect(await execution.center(OWNER)).toMatchObject({items: []});
  expect((await execution.center(OWNER, {archived: "true"})).items).toHaveLength(1);
  await expect(execution.requestEdit(OWNER, current.routineId, {...request, baseRevision: current.revision + 1})).rejects.toMatchObject({code: "invalid_transition"});
});

it("keeps a missing Bot visible as unavailable without hiding another valid owner schedule", async () => {
  const context = setup(), pending = await context.service.propose(binding, proposal);
  await context.interactions.resolve(OWNER, CHAT, pending.interactionId, {kind: "approval", decision: "approve", baseRevision: 1});
  const {insertChat, NOW} = await import("./bot-state-support.js");
  const {createBotBindingsRepository} = await import("../../../packages/gateway/src/bots/repositories/bindings.js");
  const {createBotRoutineApprovals} = await import("../../../packages/gateway/src/bots/routine-approval.js");
  const {createBotStateTransactions} = await import("../../../packages/gateway/src/bots/events.js");
  const {ChatRepository} = await import("../../../packages/gateway/src/chat/repository.js");
  const {BotStateError} = await import("../../../packages/gateway/src/bots/repositories/shared.js");
  const missingBot = "bot_abcdef0123456789", missingChat = "chat_missing_fixture";
  await insertChat(data.db, missingChat);
  await createBotBindingsRepository(data.db).bindDirect({ownerId: OWNER, botId: missingBot, chatId: missingChat, now: NOW});
  const {createBotTasksRepository} = await import("../../../packages/gateway/src/bots/repositories/tasks.js");
  const tasks = createBotTasksRepository(data.db), task = await tasks.create({ownerId: OWNER, botId: missingBot, chatId: missingChat, now: NOW});
  await tasks.transition({ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision, to: "running", runId: "run_missing_bot_fixture", now: NOW});
  const missing = await context.service.propose({...binding, botId: missingBot, chatId: missingChat, taskId: task.taskId, runId: "run_missing_bot_fixture"}, {...proposal, name: "Lost target"});
  await context.interactions.resolve(OWNER, missingChat, missing.interactionId, {kind: "approval", decision: "approve", baseRevision: 1});
  const approvals = createBotRoutineApprovals({db: data.db, transact: createBotStateTransactions(new ChatRepository(data.db as never)),
    source: {resolve: context.resolve}, definitionRevision: async (_owner, botId) => {
      if (botId === missingBot) throw new BotStateError("not_found"); return 1;
    }});
  const execution = createBotRoutineExecution({db: data.db, approvals});
  const page = await execution.center(OWNER);
  expect(page.items.find(row => row.botId === binding.botId)).toMatchObject({targetAvailable: true, sourceAvailable: true});
  expect(page.items.find(row => row.botId === missingBot)).toMatchObject({targetAvailable: false, sourceAvailable: false});
});
