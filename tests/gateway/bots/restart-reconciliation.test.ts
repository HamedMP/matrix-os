import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { runConnectionReconciliationPass, startBots } from "../../../packages/gateway/src/startup/bots.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let home: string;
let agents: ChatAgentStore;
let repository: ChatRepository;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  home = await mkdtemp(join(tmpdir(), "matrix-bot-startup-"));
  repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
  await agents.bootstrap();
});
afterEach(async () => {
  await agents.close();
  await destroy();
  await rm(home, { recursive: true, force: true });
});

function host(available = true) {
  const unregister = vi.fn();
  return {
    unregister,
    host: {
      available,
      client: { runBot: vi.fn(), stopRuntime: vi.fn(), createRuntime: vi.fn() },
      registerAuthorizer: vi.fn(() => unregister),
      close: vi.fn(),
    },
  };
}

const base = () => ({
  homePath: home,
  repository,
  agents,
  executionRoots: { resolve: vi.fn() },
  providers: { getSnapshot: vi.fn() },
});

describe("bot services at gateway start", () => {
  it("continues later owners when one inventory fails, and retries failed admission", async () => {
    const continuation = { chatId: "chat_restart1", clientRequestId: "req_answer_in_0123456789abcdef01234567", text: "Connected." };
    const reconcile = vi.fn(async (ownerId: string) => {
      if (ownerId === "bad") throw new Error("inventory unavailable");
      return [];
    });
    const pendingContinuations = vi.fn(async () => [continuation]);
    const ackContinuation = vi.fn(async () => undefined);
    const deferContinuation = vi.fn(async () => undefined);
    const deferOwner = vi.fn(async () => undefined);
    let fail = true;
    const admit = vi.fn(async () => { if (fail) throw new Error("temporarily busy"); });
    const connections = { ownersWithPending: async () => ["bad", "good"], reconcile, pendingContinuations, ackContinuation, deferContinuation, deferOwner };
    await runConnectionReconciliationPass(connections, admit);
    expect(reconcile).toHaveBeenCalledWith("good");
    expect(deferOwner).toHaveBeenCalledWith("bad");
    expect(pendingContinuations).toHaveBeenCalledWith("bad");
    expect(deferContinuation).toHaveBeenCalledWith("good", continuation.clientRequestId);
    fail = false;
    await runConnectionReconciliationPass(connections, admit);
    expect(ackContinuation).toHaveBeenCalledWith("good", continuation.clientRequestId);
  });
  it("recovers question answers without any configured integration, and stops retrying after close", async () => {
    await insertChat(db, "chat_restart_answer");
    const at = "2026-10-02T12:00:00Z";
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_restart_answer", now: at });
    const { interaction } = await createBotInteractionsRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: task.chatId, taskId: task.taskId,
      kind: "question", responderActorId: OWNER, blocking: false, payload: { kind: "question", questions: [] }, now: at, expiresAt: "2026-10-02T13:00:00Z" });
    await createBotInteractionsRepository(db).resolve({ ownerId: OWNER, interactionId: interaction.interactionId, baseRevision: 1,
      responderActorId: OWNER, resolution: { answer: "Casual", continuation: "Casual" }, now: at });
    const services = await startBots({ ...base(), now: () => new Date(at) });
    const admit = vi.fn(async () => undefined);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      services!.startConnectionReconciler(admit);
      await vi.advanceTimersByTimeAsync(30_001);
      await vi.waitFor(() => expect(admit).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () => expect((await createBotInteractionsRepository(db).get({ ownerId: OWNER, interactionId: interaction.interactionId }))?.resolution?.continuationAdmittedAt).toBeDefined());
      await services!.close();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(admit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("marks tool calls the previous process left dispatched as effect unknown, before any run", async () => {
    await insertChat(db, "chat_restart1");
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_restart1", now: "2026-09-27T12:00:00.000Z" });
    const checkpoints = createBotCheckpointsRepository(db);
    const prepared = await checkpoints.prepare({
      ownerId: OWNER, taskId: task.taskId, runId: "run_lost1", toolCallId: "call_1", action: { capability: "artifact.write" },
      effectClass: "write", now: "2026-09-27T12:00:00.000Z",
    });
    await checkpoints.markDispatched({ ownerId: OWNER, checkpointId: prepared.checkpoint.checkpointId, now: "2026-09-27T12:00:01.000Z" });
    const { host: runtimeHost, unregister } = host();

    const services = await startBots({ ...base(), host: runtimeHost as never, now: () => new Date("2026-09-28T09:00:00.000Z") });
    expect(services?.adapter?.driverKind).toBe("matrix_bot");
    await expect(checkpoints.listForRun({ ownerId: OWNER, runId: "run_lost1" }))
      .resolves.toEqual([expect.objectContaining({ phase: "effect_unknown" })]);
    expect(runtimeHost.registerAuthorizer).toHaveBeenCalledWith(expect.objectContaining({ id: "bots" }));
    // Nothing was replayed.
    expect(runtimeHost.client.runBot).not.toHaveBeenCalled();
    await services!.close();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("finishes closing old checkpoints in the background when there are more than startup takes", async () => {
    await insertChat(db, "chat_restart2");
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_restart2", now: "2026-09-27T12:00:00.000Z" });
    const checkpoints = createBotCheckpointsRepository(db);
    for (let index = 0; index < 250; index += 1) {
      const prepared = await checkpoints.prepare({
        ownerId: OWNER, taskId: task.taskId, runId: "run_lost2", toolCallId: `call_${index}`, action: { capability: "artifact.write", index },
        effectClass: "write", now: "2026-09-27T12:00:00.000Z",
      });
      await checkpoints.markDispatched({ ownerId: OWNER, checkpointId: prepared.checkpoint.checkpointId, now: "2026-09-27T12:00:01.000Z" });
    }
    const { host: runtimeHost } = host();
    const services = await startBots({
      ...base(), host: runtimeHost as never, now: () => new Date("2026-09-28T09:00:00.000Z"),
      checkpointReconcile: { passes: 1, intervalMs: 10 },
    });
    const dispatched = async () => Number((await db.selectFrom("bot_tool_checkpoints").select((eb) => eb.fn.countAll<number>().as("count"))
      .where("phase", "=", "dispatched").executeTakeFirstOrThrow()).count);
    // One pass (200) at start; the rest in the background.
    await vi.waitFor(async () => expect(await dispatched()).toBe(0));
    await services!.close();
  });

  it("resolves only live recipe-bot Chats belonging to the requesting owner", async () => {
    const services = await startBots(base());
    try {
      const created = await services!.instantiation.instantiate(OWNER, {
        clientRequestId: "req_sidebar_0123456789abcdef",
        recipe: { recipeId: "writing-bot", version: "2026-09-27.1" },
      });
      const owner = { type: "personal" as const, ownerId: OWNER };
      await expect(services!.botChats.directChat!(owner, created.agent.id)).resolves.toBe(created.chatId);
      await expect(services!.botChats.directChat!({ type: "personal", ownerId: "other_owner" }, created.agent.id)).resolves.toBeNull();
      await expect(services!.botChats.directChat!({ type: "org", ownerId: OWNER }, created.agent.id)).resolves.toBeNull();
      await agents.update(owner, created.agent.id, { baseRevision: created.agent.revision, archived: true });
      await expect(services!.botChats.directChat!(owner, created.agent.id)).resolves.toBeNull();
    } finally { await services!.close(); }
  });

  it("offers creation but no bot runtime when the scope runtime is unavailable", async () => {
    const { host: down } = host(false);
    const services = await startBots({ ...base(), host: down as never });
    expect(services?.instantiation).toBeDefined();
    expect(services?.adapter).toBeUndefined();
    expect(down.registerAuthorizer).not.toHaveBeenCalled();
    await expect(services!.botChats.directBot({ type: "personal", ownerId: OWNER }, "chat_none")).resolves.toBeNull();
    await services!.close();
  });

  it("leaves bots unavailable, without failing the gateway, when bot state cannot be prepared", async () => {
    const closed = await createBotStateDatabase({ migrate: false });
    await closed.destroy();
    await expect(startBots({ ...base(), repository: { kysely: closed.db, withTransaction: vi.fn() } as never })).resolves.toBeUndefined();
  });
});
