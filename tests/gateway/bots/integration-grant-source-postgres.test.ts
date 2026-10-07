import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { BOT, OWNER, NOW, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("Integration source/grant admission on pooled PostgreSQL", () => {
  it.each(["revoke", "revise"])("holds the exact grant through final source qualification before concurrent %s", async mutation => {
    const { db, destroy } = await createRealBotStateDatabase(); cleanup.push(destroy);
    const chatId = "chat_grantsource";
    await insertChat(db, chatId);
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId, now: NOW });
    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId, now: NOW });
    const grant = (await createBotGrantsRepository(db).grant({ ownerId: OWNER, botId: BOT, service: "gmail",
      connectionId: "conn_work", accountLabel: "Work", effects: ["read", "send"], audience: "direct", grantedByActorId: OWNER, now: NOW })).grant;
    await expect(createBotGrantsRepository(db).findUsable({ ownerId: OWNER, botId: BOT, service: "gmail",
      connectionId: "conn_work", audience: "direct", effect: "read", now: NOW, lockForDispatch: true })).rejects.toMatchObject({ code: "invalid_input" });
    const base = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
    let transactionActive = false, sourceChecks = 0;
    const sourceEntered = deferred(), sourceRelease = deferred(), writerEntered = deferred();
    const call = vi.fn(async () => {
      expect(transactionActive).toBe(false); // transport is outside the grant transaction
      return { data: { fixture: true } };
    });
    const tools = createBotIntegrationTools({
      client: { inventory: async () => [{ connectionId: "conn_work", service: "gmail", label: "Work" }], call },
      transact: async (ownerId, work) => {
        transactionActive = true;
        try { return await base(ownerId, work); } finally { transactionActive = false; }
      },
      agents: { get: async () => ({ recipeRef: { recipeId: "mail-helper", version: "1" } }) as never },
      recipes: createBotRecipeCatalog([{ recipeId: "mail-helper", version: "1", name: "Mail Helper",
        description: "Fixture", instructions: "Fixture", capabilities: ["integration.call"],
        integrations: [{ service: "gmail", effects: ["read", "send"], required: true }], output: "Fixture" }]),
      now: () => new Date(NOW),
      assertSource: async () => { if (++sourceChecks === 2) { sourceEntered.resolve(); await sourceRelease.promise; } },
    });
    const binding: BotRuntimeBinding = { runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "1",
      ownerId: OWNER, botId: BOT, chatId, taskId: task.taskId, runId: "run_grantsource", rootFingerprint: "f".repeat(64),
      route: { api: "anthropic-messages", modelId: "claude-synthetic", input: ["text"], contextWindow: 200000, maxOutputTokens: 8192 },
      accessSourceId: "owner_anthropic_key", capabilities: ["integration.call"], requestClass: "interactive" };
    const pending = tools.call(binding, { service: "gmail", action: "list_threads", connectionId: "conn_work", params: {} });
    await sourceEntered.promise;
    let writerPid = 0, writerCommitted = false;
    const writer = db.transaction().execute(async tx => {
      writerPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]!.pid;
      writerEntered.resolve();
      if (mutation === "revoke") await createBotGrantsRepository(tx).revoke({ ownerId: OWNER, grantId: grant.grantId, now: NOW }, tx);
      else await createBotGrantsRepository(tx).updateEffects({ ownerId: OWNER, grantId: grant.grantId,
        baseRevision: grant.revision, effects: ["read"], now: NOW }, tx);
    }).then(() => { writerCommitted = true; });
    try {
      await writerEntered.promise;
      await vi.waitFor(async () => {
        const activity = await sql<{ wait_event_type: string | null }>`select wait_event_type from pg_stat_activity where pid = ${writerPid}`.execute(db);
        expect(activity.rows[0]?.wait_event_type).toBe("Lock");
      });
      expect(writerCommitted).toBe(false);
      expect(call).not.toHaveBeenCalled();
    } finally { sourceRelease.resolve(); }
    // Admission commits first; revocation affects subsequent admissions.
    await expect(pending).resolves.toMatchObject({ ok: true });
    await writer;
    expect(writerCommitted).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    await expect(tools.call(binding, { service: "gmail", action: "list_threads", connectionId: "conn_work", params: {} })).resolves.toMatchObject({ ok: true });
    if (mutation === "revoke") expect(call).toHaveBeenCalledTimes(1);
  });
});
