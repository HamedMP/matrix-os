import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BOT_ROUTINE_ORIGIN_ACCEPT, CanonicalChatContentSchema } from "@matrix-os/contracts";
import { sql } from "kysely";
import { applyCanonicalChatContent } from "../../../packages/ui/src/canonical-chat-content.js";
import { createBotRoutineApprovals } from "../../../packages/gateway/src/bots/routine-approval.js";
import { createRoutineChatOriginService } from "../../../packages/gateway/src/bots/routine-chat-origin.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotRoutinesRepository } from "../../../packages/gateway/src/bots/repositories/routines.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import { createBotRoutineRoutes } from "../../../packages/gateway/src/bots/routine-routes.js";
import { createBotRoutineManagement } from "../../../packages/gateway/src/bots/routine-management.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatOutboxEvent } from "../../../packages/gateway/src/chat/records.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createRealBotStateDatabase, insertChat, NOW, OWNER, at } from "./bot-state-support.js";
import { context, invocation, SOURCE_SCOPE } from "./routine-cli-source-support.js";
import { admitFixtureRun, decisionProof, machine, publishRoutineFixtureChatThroughProject } from "./routine-chat-origin-support.js";
import { backendPid, barrier, bounded } from "./routine-postgres-support.js";
import { proposal } from "./routine-cli-request-support.js";

const originChatId = "chat_source";
const botId = `bot_routine${"c".repeat(32)}`;
const chatId = `chat_routine_${"d".repeat(32)}`;
const owner = { type: "personal" as const, ownerId: OWNER };
const requestId = invocation(101);
const computerId = SOURCE_SCOPE.computerId;

async function setup() {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required");
  const { db, destroy } = await createRealBotStateDatabase(url, { routineAuthority: true });
  const chats = new ChatRepository(db as never);
  const state = { clock: NOW };
  const transact = createBotStateTransactions(chats);
  const route = { api: "openai-responses" as const, modelId: proposal.selection.model, input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256 };
  const subscription = { accountId: "fixture-account", computerId, grantRevision: 1, peerId: invocation(900) };
  const approvals = createBotRoutineApprovals({ db, transact, now: () => new Date(state.clock), definitionRevision: async () => 1,
    source: { resolve: async () => ({ route, accessSourceId: "matrix_chatgpt_plan", subscription }) } });
  const interactions = createBotInteractionService({ transact, now: () => new Date(state.clock), handlers: { decideApproval: approvals.decide,
    chooseAccount: async () => { throw new Error("No external account interactions in this fixture"); } } });
  const getAgent = vi.fn(async () => undefined);
  const origin = createRoutineChatOriginService({ db, chats, transact, interactions, agents: { get: getAgent },
    computerId, expectedMachine: machine, now: () => new Date(state.clock) });
  try {
    await admitFixtureRun({ chats, state });
    await insertChat(db, chatId);
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId, chatId, now: NOW });
    await db.insertInto("routine_direct_chat_contexts").values({ owner_id: OWNER, computer_id: computerId, source_chat_id: originChatId,
      bot_id: botId, chat_id: chatId, activated_at: NOW }).execute();
    const tasks = createBotTasksRepository(db);
    const task = await tasks.create({ ownerId: OWNER, botId, chatId, now: NOW });
    const runId = "run_canonical_proposal";
    await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision, to: "running", runId, now: NOW });
    const binding: BotRuntimeBinding = { runtimeHandle: "runtime_" + "f".repeat(32), executionGeneration: "1", ownerId: OWNER, botId, chatId,
      taskId: task.taskId, runId, rootFingerprint: "a".repeat(64), route, accessSourceId: "matrix_chatgpt_plan", subscription,
      capabilities: [], requestClass: "interactive" };
    const target = { ...SOURCE_SCOPE, botId, chatId, bindingCreatedAt: NOW, purpose: "direct_chat" as const, sourceChatId: originChatId };
    // Only the already-claimed tool intent is fixture data. Approval, decisions, fires and delivery use the real PostgreSQL services.
    await db.insertInto("routine_cli_requests").values({ owner_id: OWNER, computer_id: computerId, client_request_id: requestId,
      operation_digest: "a".repeat(64), operation: { operation: "propose", requestId, proposal },
      source_context: { ...context(), harness: "pi", identity: { kind: "chat_run", chatId: originChatId, runId: "run_source", route: "managed" } },
      source_invocation: { sourceId: "rsrc_" + "b".repeat(64), invocationId: invocation(102), operationDigest: "a".repeat(64) },
      target_snapshot: target, admission: { disposition: "queued" }, created_at: NOW }).execute();
    await db.insertInto("routine_cli_proposals").values({ owner_id: OWNER, computer_id: computerId, client_request_id: requestId,
      canonical_request_id: "req_cli_routine_" + "a".repeat(32), request_hash: "d".repeat(64), stage: "target_task_claimed",
      run_id: runId, task_id: task.taskId, interaction_id: null, runtime_handle: null, execution_generation: null,
      created_at: NOW, updated_at: NOW }).execute();
    const pend = async () => {
      const pending = await approvals.propose(binding, proposal);
      await db.updateTable("routine_cli_proposals").set({ stage: "pending_approval", interaction_id: pending.interactionId,
        runtime_handle: binding.runtimeHandle, execution_generation: binding.executionGeneration }).where("client_request_id", "=", requestId).execute();
      return pending.interactionId;
    };
    const request = { kind: "approval" as const, decision: "approve" as const, baseRevision: 1 };
    const approve = (interactionId: string) => origin.resolve(OWNER, originChatId, interactionId, request, decisionProof({ state }, interactionId));
    const repo = createBotRoutinesRepository(db);
    return { db, chats, state, approvals, interactions, origin, getAgent, pend, approve, repo, tasks, target, binding, request,
      close: async () => { await origin.close(); await chats.release(); await destroy(); } };
  } catch (error: unknown) {
    await origin.close();
    await chats.release();
    await destroy();
    throw error;
  }
}

let f: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => { f = await setup(); });
afterEach(async () => { await f?.close(); });

it("requires the exact originating Chat for a claimed scheduler proposal and for its decision", async () => {
  await insertChat(f.db, "chat_other");
  await f.db.updateTable("routine_cli_requests").set({ target_snapshot: { ...f.target, sourceChatId: "chat_other" } })
    .where("client_request_id", "=", requestId).execute();
  await expect(f.approvals.propose(f.binding, proposal)).rejects.toMatchObject({ code: "not_found" });
  await f.db.updateTable("routine_cli_requests").set({ target_snapshot: f.target }).where("client_request_id", "=", requestId).execute();
  const interactionId = await f.pend();
  expect((await f.origin.read(OWNER, "chat_other", true)).pending).toEqual([]);
  await expect(f.interactions.resolve(OWNER, chatId, interactionId, f.request)).rejects.toMatchObject({ code: "not_found" });
  expect(await f.repo.list(OWNER, botId)).toEqual([]);
  await f.approve(interactionId);
  expect((await f.origin.read(OWNER, originChatId, true)).history).toMatchObject([{ anchorMessageId: "msg_run_source", decision: "approve" }]);
  const [routine] = await f.repo.list(OWNER, botId);
  const manager = createBotRoutineManagement(f.db, f.approvals);
  await expect(manager.detail(OWNER, routine!.routineId)).rejects.toMatchObject({ code: "not_found" });
  expect((await manager.detail(OWNER, routine!.routineId, true)).routine).toMatchObject({
    chatId: originChatId, originChatId, originAvailable: true, sourceAvailable: true,
  });
  const edit = await f.approvals.requestEdit(OWNER, routine!.routineId, { baseRevision: 1, name: "Edited task",
    prompt: "Edited fixture", schedule: { kind: "interval", everyMs: 120_000 } });
  expect((await manager.center(OWNER)).pending).toEqual([]);
  expect((await f.origin.read(OWNER, originChatId, true)).pending).toMatchObject([{ interaction: { interactionId: edit.interaction.interactionId } }]);
  await f.approve(edit.interaction.interactionId);
  expect((await f.repo.get(OWNER, routine!.routineId))?.proposal.name).toBe("Edited task");
});

it("exposes the original Chat for a direct schedule without exposing internal destinations", async () => {
  const interactionId = await f.pend();
  const visible = await f.origin.read(OWNER, originChatId, true, true);
  expect(visible.pending).toMatchObject([{ interaction: {
    interactionId, chatId: originChatId, agentId: "bot_matrixschedules",
  } }]);
  expect(visible.pending[0]).not.toHaveProperty("executorName");
  expect(f.getAgent).not.toHaveBeenCalled();
  expect(JSON.stringify(visible.pending)).not.toContain(botId);
  expect(JSON.stringify(visible.pending)).not.toContain(chatId);
  await f.approve(interactionId);

  const [routine] = await f.repo.list(OWNER, botId);
  const routes = (userId: string) => createBotRoutineRoutes({
    routines: createBotRoutineExecution({ db: f.db, approvals: f.approvals, now: () => new Date(f.state.clock) }),
    getPrincipal: () => ({ userId, source: "jwt" }),
  });
  const app = routes(OWNER), list = "/api/bot-routines", detail = list + "/" + routine!.routineId;
  const accept = { headers: { Accept: BOT_ROUTINE_ORIGIN_ACCEPT } };
  expect(await (await app.request(list)).json()).toMatchObject({ items: [], nextCursor: null });
  expect((await app.request(detail)).status).toBe(404);
  const expected = { routineId: routine!.routineId, botId: "bot_matrixschedules", chatId: originChatId,
    originChatId, originAvailable: true, sourceAvailable: true };
  const center = await (await app.request(list, accept)).json(), selected = await (await app.request(detail, accept)).json();
  expect(center).toMatchObject({ items: [expected] });
  expect(selected).toMatchObject({ routine: expected });
  expect(JSON.stringify([center, selected])).not.toContain(botId);
  expect(JSON.stringify([center, selected])).not.toContain(chatId);
  const edit = await app.request(detail + "/review", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseRevision: 1, name: "Edited task", prompt: "Edit fixture",
      schedule: { kind: "interval", everyMs: 120_000 } }),
  });
  expect(edit.status).toBe(200);
  const editResponse = await edit.json();
  expect(editResponse).toMatchObject({ interaction: { chatId: originChatId, agentId: "bot_matrixschedules" } });
  expect(JSON.stringify(editResponse)).not.toContain(botId);
  expect(JSON.stringify(editResponse)).not.toContain(chatId);

  const pause = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "paused", baseRevision: 1 }) };
  expect((await routes("another_owner").request(detail + "/control", pause)).status).toBe(404);
  expect(await (await app.request(detail + "/control", pause)).json()).toMatchObject({ status: "paused", revision: 2 });
});

it.each(["missing", "revoked"])("hides an unavailable direct schedule from both list/read wires: %s", async (condition) => {
  await f.approve(await f.pend());
  const [routine] = await f.repo.list(OWNER, botId);
  if (condition === "missing") {
    await f.db.deleteFrom("chats").where("id", "=", originChatId).execute();
  } else {
    await publishRoutineFixtureChatThroughProject(f.db, originChatId, NOW);
  }
  const app = createBotRoutineRoutes({
    routines: createBotRoutineExecution({ db: f.db, approvals: f.approvals, now: () => new Date(f.state.clock) }),
    getPrincipal: () => ({ userId: OWNER, source: "jwt" }),
  });
  for (const init of [{}, { headers: { Accept: BOT_ROUTINE_ORIGIN_ACCEPT } }]) {
    const list = await app.request("/api/bot-routines", init);
    const detail = await app.request("/api/bot-routines/" + routine!.routineId, init);
    expect(await list.json()).toMatchObject({ items: [] });
    expect(detail.status).toBe(404);
    const body = await detail.text();
    expect(body).not.toContain(botId);
    expect(body).not.toContain(chatId);
  }
});

it("serializes activation with a concurrent source archive and leaves no active routine", async () => {
  const interactionId = await f.pend();
  const locked = barrier<number>(), release = barrier<void>();
  const blocker = f.db.transaction().execute(async tx => {
    await tx.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", originChatId).execute();
    locked.resolve(await backendPid(tx));
    await release.promise;
  });
  const blockerPid = await bounded(locked.promise);
  const decision = f.approve(interactionId).then(() => "accepted", () => "refused");
  try {
    await expect.poll(async () => {
      const result = await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock'
        AND query LIKE '%chats%' AND ${blockerPid}=ANY(pg_blocking_pids(pid))`.execute(f.db);
      return result.rows[0]?.pid;
    }).not.toBeUndefined();
  } finally {
    release.resolve();
    await blocker;
    expect(await decision).toBe("refused");
  }
  expect(await f.repo.list(OWNER, botId)).toEqual([]);
});

it.each(["archive", "project publication"])("fences future and already claimed fires after source %s", async (change) => {
  await f.approve(await f.pend());
  const [routine] = await f.repo.list(OWNER, botId);
  const due = routine!.nextFireAt!;
  const fire = await f.repo.claim({ ownerId: OWNER, routineId: routine!.routineId, scheduledFor: due, nextFireAt: at(120_000), now: due });
  expect(fire?.status).toBe("claimed");
  if (change === "archive") {
    await f.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", originChatId).execute();
  } else {
    await publishRoutineFixtureChatThroughProject(f.db, originChatId, due);
  }
  expect(await f.repo.dispatch({ ownerId: OWNER, fireId: fire!.fireId, now: due })).toBeUndefined();
  expect(await f.repo.pending(due)).toEqual([]);
  expect(await f.approvals.authorize(routine!)).toBe(false);
  const manager = createBotRoutineManagement(f.db, f.approvals);
  await expect(manager.detail(OWNER, routine!.routineId, true)).rejects.toMatchObject({ code: "not_found" });
  expect(await f.repo.claim({ ownerId: OWNER, routineId: routine!.routineId, scheduledFor: at(120_000), nextFireAt: at(180_000), now: at(120_000) })).toBeUndefined();
});

it("keeps the original review anchor and orders two committed results around an ordinary Chat turn", async () => {
  const firstId = await f.pend();
  await f.approve(firstId);
  const [routine] = await f.repo.list(OWNER, botId);
  const record = (await f.chats.get(owner, originChatId))!;
  await f.chats.finishRun(owner, { chatId: originChatId, runId: "run_source", outcome: "completed", completedAt: NOW,
    output: { id: "msg_source_ack", chatId: originChatId, seq: record.chat.messageCount + 1, role: "assistant", state: "committed",
      runId: "run_source", turnId: "cturn_run_source", parts: [{ type: "text", text: "Schedule proposed" }], createdAt: NOW } });
  for (const occurrence of [1, 2]) {
    const due = at(occurrence * 60_000);
    f.state.clock = due;
    const fire = await f.repo.claim({ ownerId: OWNER, routineId: routine!.routineId, scheduledFor: due, nextFireAt: at((occurrence + 1) * 60_000), now: due });
    expect(fire).toBeDefined();
    expect(await f.repo.dispatch({ ownerId: OWNER, fireId: fire!.fireId, now: due })).toBeDefined();
    const run = await admitFixtureRun(f, chatId, `run_output_${occurrence}`);
    await f.tasks.transition({ ownerId: OWNER, taskId: fire!.taskId, baseRevision: 1, to: "running", runId: run.run.id, now: due });
    const target = (await f.chats.get(owner, chatId))!;
    await f.chats.finishRun(owner, { chatId, runId: run.run.id, outcome: "completed", completedAt: due,
      output: { id: `msg_result_${occurrence}`, chatId, seq: target.chat.messageCount + 1, role: "assistant", state: "committed", runId: run.run.id,
        turnId: run.turn.id, parts: [{ type: "text", text: `Committed scheduled result ${occurrence}` }], createdAt: due } });
    expect(await f.repo.finish({ ownerId: OWNER, fireId: fire!.fireId, status: "completed", expectedStatus: "dispatched", now: due })).toBe(true);
    const beforeDelivery = (await f.chats.getDetailPage(owner, originChatId, { limit: 30 }))!;
    const committedEvents: ChatOutboxEvent[] = [];
    const subscription = f.chats.registerOutboxSink(({ event }) => { committedEvents.push(event); });
    try {
      await f.origin.reconcile(OWNER, originChatId);
    } finally {
      subscription.dispose();
    }
    expect(committedEvents).toHaveLength(1);
    const { payload, ...event } = committedEvents[0]!;
    const content = CanonicalChatContentSchema.parse(payload.streamContent);
    expect(event).toMatchObject({ eventType: "chat.updated", chatId: originChatId });
    expect(content.messages).toMatchObject([{ role: "system", state: "committed", parts: [
      { type: "routine_receipt", fireId: fire!.fireId },
      { type: "text", text: `Committed scheduled result ${occurrence}` },
    ] }]);
    expect(applyCanonicalChatContent(beforeDelivery, { type: "chat.content", event, content })?.messages)
      .toEqual((await f.chats.getDetailPage(owner, originChatId, { limit: 30 }))?.messages);
    if (occurrence === 1) await admitFixtureRun(f, originChatId, "run_between_results");
  }
  const sourceView = await f.origin.read(OWNER, originChatId, true);
  expect(sourceView.history).toMatchObject([{ anchorMessageId: "msg_run_source", decision: "approve", interaction: { interactionId: firstId } }]);
  expect(sourceView.deliveries).toHaveLength(2);
  const timeline = await f.db.selectFrom("chat_messages").select(["id", "parts"]).where("chat_id", "=", originChatId).orderBy("seq").execute();
  expect(timeline.map(message => (message.parts[0] as { canonicalMessageId?: string }).canonicalMessageId ?? message.id)).toEqual([
    "msg_run_source", "msg_source_ack", "msg_result_1", "msg_run_between_results", "msg_result_2",
  ]);
});
