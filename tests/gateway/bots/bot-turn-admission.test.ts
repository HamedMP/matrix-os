import { Hono } from "hono";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import type { Kysely } from "kysely";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotConnections } from "../../../packages/gateway/src/bots/connections.js";
import { createBotContinuationAdmitter } from "../../../packages/gateway/src/bots/continuations.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { runConnectionReconciliationPass } from "../../../packages/gateway/src/startup/bots.js";
import { createRealBotStateDatabase } from "./bot-state-support.js";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withBotProviderInstance } from "../../../packages/gateway/src/bots/provider-instance.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { ChatConflictError, ChatNotFoundError, ChatQueuedTurnCancelledError } from "../../../packages/gateway/src/chat/errors.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_bot_turns" };
const principal = { userId: owner.ownerId, source: "jwt" as const };
const BOT_CHAT = "chat_bot_direct";

let repository: ChatRepository;
let destroyFixture: (() => Promise<void>) | undefined;
let orchestrator: CanonicalChatOrchestrator;
let finishBlockedRun: (() => void) | undefined;
let blockedRun: Promise<void> | undefined;
let getCatalog: ReturnType<typeof vi.fn>;
let started: Array<{ selection: unknown; permissionMode: string }>;

beforeEach(async () => {
  if (process.env.MATRIX_TEST_POSTGRES_URL) {
    const fixture = await createRealBotStateDatabase();
    repository = new ChatRepository(fixture.db as unknown as Kysely<import("../../../packages/gateway/src/chat/database.js").ChatDatabase>);
    destroyFixture = fixture.destroy;
  } else {
    repository = new ChatRepository((await KyselyPGlite.create()).dialect);
    await bootstrapBotDatabase(repository.kysely as unknown as Kysely<OwnerBotDatabase>);
    destroyFixture = () => repository.kysely.destroy();
  }
  await repository.bootstrap();
  started = [];
  finishBlockedRun = undefined;
  blockedRun = undefined;
  getCatalog = vi.fn(async () => ({ revision: "rev_bots", drivers: [], instances: [] }));
  const bot: CanonicalChatProviderAdapter<{ taskId: string }> = {
    driverKind: "matrix_bot",
    stateSchemaVersion: 1,
    parseState: (value) => value as { taskId: string },
    serializeState: (value) => value,
    async *start(input) {
      started.push({ selection: input.selection, permissionMode: input.permissionMode });
      if (blockedRun) await blockedRun;
      yield { type: "assistant.delta", delta: "Hello" };
      yield { type: "run.completed", outcome: "completed" };
    },
  };
  orchestrator = new CanonicalChatOrchestrator({
    repository,
    catalog: withBotProviderInstance({ getCatalog }),
    adapters: new CanonicalChatProviderRegistry([bot]),
    agentContext: new ChatAgentContext({
      repository, agents: { get: vi.fn(async () => null) }, enabled: () => true,
      botChats: { directBot: async (_owner, chatId) => (chatId === BOT_CHAT ? "bot_0123456789abcdef01234567" : null) },
    }),
  });
  for (const id of [BOT_CHAT, "chat_ordinary"]) await repository.create(owner, { id, clientRequestId: `req_${id}`, title: id });
});
afterEach(async () => {
  finishBlockedRun?.();
  await orchestrator.drain();
  await orchestrator.close();
  await destroyFixture?.();
  destroyFixture = undefined;
});

describe("turns in a bot's chat", () => {
  it("run on the bot runtime with the bot's permission mode, whatever the client sent", async () => {
    const admitted = await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_turn_1", baseRevision: 0, parts: [{ type: "text", text: "Tighten my intro" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" }, interactionMode: "plan", permissionMode: "read_only",
    });
    expect(admitted.run).toMatchObject({ driverKind: "matrix_bot", instanceId: "matrix_bot_default", permissionMode: "default", interactionMode: "default" });
    await vi.waitFor(async () => expect((await repository.get(owner, BOT_CHAT))?.activeRun).toBeUndefined());
    expect(started).toEqual([{ selection: { instanceId: "matrix_bot_default", model: "auto" }, permissionMode: "default" }]);
  });

  it("admit direct bot turns while the ordinary harness catalog is unavailable", async () => {
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    const admitted = await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_harness_down", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    });
    expect(admitted.run.driverKind).toBe("matrix_bot");
    expect(getCatalog).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });

  it("retry a stored bot selection without reading the ordinary harness catalog", async () => {
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    const first = await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_bot_retry_first", baseRevision: 0, parts: [{ type: "text", text: "first" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    });
    await vi.waitFor(async () => expect((await repository.get(owner, BOT_CHAT))?.activeRun).toBeUndefined());
    const current = await repository.get(owner, BOT_CHAT);
    const retry = await orchestrator.retryTurn(principal, owner, BOT_CHAT, first.turn.id, {
      clientRequestId: "req_bot_retry", baseRevision: current!.chat.revision,
    });
    expect(retry.run.driverKind).toBe("matrix_bot");
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it("queue a server-selected bot turn while ordinary harness settings are unavailable", async () => {
    blockedRun = new Promise<void>((resolve) => { finishBlockedRun = resolve; });
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_active_bot", baseRevision: 0, parts: [{ type: "text", text: "first" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const current = await repository.get(owner, BOT_CHAT);
    const queued = await orchestrator.enqueueQueuedTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_queued_bot", baseRevision: current!.chat.revision, parts: [{ type: "text", text: "next" }],
      selection: { instanceId: "codex_default", model: "auto" }, interactionMode: "plan", permissionMode: "read_only",
    });
    expect(queued.queuedTurn.selection).toEqual({ instanceId: "matrix_bot_default", model: "auto" });
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles a recorded answer after full queue and restart (owner cancelled: %s)", async (cancelAnswer) => {
    blockedRun = new Promise<void>((resolve) => { finishBlockedRun = resolve; });
    const selection = { instanceId: "matrix_bot_default", model: "auto" };
    await orchestrator.admitTurn(principal, owner, BOT_CHAT, {
      clientRequestId: "req_capacity_active", baseRevision: 0, parts: [{ type: "text", text: "first" }],
      selection, interactionMode: "default", permissionMode: "default",
    });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const queuedIds: string[] = [];
    for (let index = 0; index < 20; index++) {
      const current = await repository.get(owner, BOT_CHAT);
      const queued = await orchestrator.enqueueQueuedTurn(principal, owner, BOT_CHAT, {
        clientRequestId: `req_capacity_${index}`, baseRevision: current!.chat.revision,
        parts: [{ type: "text", text: `Queued ${index}` }], selection, interactionMode: "default", permissionMode: "default",
      });
      queuedIds.push(queued.queuedTurn.id);
    }
    let clock = new Date("2026-10-02T12:00:00Z");
    const state = repository.kysely as unknown as Kysely<OwnerBotDatabase>;
    const task = await createBotTasksRepository(state).create({ ownerId: owner.ownerId, botId: "bot_0123456789abcdef01234567", chatId: BOT_CHAT, now: clock.toISOString() });
    const { interaction } = await createBotInteractionsRepository(state).create({
      ownerId: owner.ownerId, botId: task.botId, chatId: BOT_CHAT, taskId: task.taskId, responderActorId: owner.ownerId,
      kind: "question", blocking: false, payload: { kind: "question", questions: [{ questionId: "q1", header: "Tone", question: "Which tone?", secret: false, allowOther: true }] },
      now: clock.toISOString(), expiresAt: new Date(clock.getTime() + 3600_000).toISOString(),
    });
    const transact = createBotStateTransactions(repository);
    const interactions = createBotInteractionService({ transact, now: () => clock });
    const body = { kind: "question", baseRevision: 1, answer: "Casual" };
    const admit = createBotContinuationAdmitter({ repository, orchestrator });
    const app = new Hono();
    app.route("/", createBotRoutes({ interactions, admitContinuation: admit, getPrincipal: () => principal }));
    const answer = () => app.request(`/api/chats/${BOT_CHAT}/interactions/${interaction.interactionId}/resolve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await answer()).status).toBe(503);
    const recovery = () => createBotConnections({ transact, client: { inventory: vi.fn() } as never,
      tools: { declaredEffects: vi.fn() }, now: () => clock });
    expect(await recovery().ownersWithPending()).toContain(owner.ownerId);
    await runConnectionReconciliationPass(recovery(), admit);
    const stored = await createBotInteractionsRepository(state).get({ ownerId: owner.ownerId, interactionId: interaction.interactionId });
    expect(stored?.resolution?.continuationAdmittedAt).toBeUndefined();
    expect(await recovery().pendingContinuations(owner.ownerId)).toEqual([]); // bounded retry delay
    const current = await repository.get(owner, BOT_CHAT);
    await repository.cancelQueuedTurn(owner, { chatId: BOT_CHAT, queuedTurnId: queuedIds[0]!, clientRequestId: "req_capacity_cancel",
      baseRevision: current!.chat.revision, cancelledAt: clock.toISOString() });
    clock = new Date(clock.getTime() + 60_001);
    // Reconstruct service objects as after a process restart; no client retry is needed.
    const pending = (await recovery().pendingContinuations(owner.ownerId))[0]!;
    await admit(principal, pending); // admission succeeds, process dies before acknowledgment
    if (cancelAnswer) {
      const answerRow = await repository.kysely.selectFrom("chat_queued_turns").selectAll()
        .where("client_request_id", "=", pending.clientRequestId).executeTakeFirstOrThrow();
      const latest = await repository.get(owner, BOT_CHAT);
      await repository.cancelQueuedTurn(owner, { chatId: BOT_CHAT, queuedTurnId: answerRow.id,
        clientRequestId: "req_cancel_answer", baseRevision: latest!.chat.revision, cancelledAt: clock.toISOString() });
      await expect(repository.findQueuedAdmission(owner, BOT_CHAT, pending.clientRequestId, "mismatched-content"))
        .rejects.toMatchObject({ name: "ChatConflictError" });
      await expect(repository.findQueuedAdmission({ type: "personal", ownerId: "other_owner" }, BOT_CHAT, pending.clientRequestId))
        .rejects.toBeInstanceOf(ChatNotFoundError);
      await expect(repository.findQueuedAdmission(owner, BOT_CHAT, pending.clientRequestId))
        .rejects.toBeInstanceOf(ChatQueuedTurnCancelledError);
      await expect(repository.findQueuedAdmission(owner, BOT_CHAT, pending.clientRequestId))
        .rejects.toBeInstanceOf(ChatConflictError); // ordinary queue clients retain the conflict contract

    }
    await runConnectionReconciliationPass(recovery(), admit);
    const rows = await repository.kysely.selectFrom("chat_queued_turns").selectAll()
      .where("client_request_id", "=", `req_answer_${interaction.interactionId}`).execute();
    expect(rows).toHaveLength(1);
    const settled = await createBotInteractionsRepository(state).get({ ownerId: owner.ownerId, interactionId: interaction.interactionId });
    expect(settled?.resolution?.[cancelAnswer ? "continuationCancelledAt" : "continuationAdmittedAt"]).toBeDefined();
    expect(settled?.resolution?.[cancelAnswer ? "continuationAdmittedAt" : "continuationCancelledAt"]).toBeUndefined();
    clock = new Date(clock.getTime() + 60_001);
    expect(await recovery().ownersWithPending()).not.toContain(owner.ownerId);
    expect(await recovery().pendingContinuations(owner.ownerId)).toEqual([]);
    expect((await answer()).status).toBe(200); // identical answer still idempotent after delivery acknowledgment
    expect(await repository.kysely.selectFrom("chat_queued_turns").selectAll()
      .where("client_request_id", "=", `req_answer_${interaction.interactionId}`).execute()).toHaveLength(1);
  });

  it("preserve ordinary catalog failures and reject forged bot routing", async () => {
    getCatalog.mockRejectedValue(new Error("Harness settings unavailable"));
    await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", {
      clientRequestId: "req_ordinary_down", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "codex_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    })).rejects.toThrow("Harness settings unavailable");
    getCatalog.mockClear();
    await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", {
      clientRequestId: "req_forged_down", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    })).rejects.toMatchObject({ status: 400 });
    expect(getCatalog).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it("are the only turns that can reach the bot runtime", async () => {
    await expect(orchestrator.admitTurn(principal, owner, "chat_ordinary", {
      clientRequestId: "req_turn_2", baseRevision: 0, parts: [{ type: "text", text: "hi" }],
      selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default",
    })).rejects.toMatchObject({ status: 400 });
    expect(started).toEqual([]);
  });
});
