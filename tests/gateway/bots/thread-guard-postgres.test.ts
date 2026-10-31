/** Actual PG fixture data only; adapters are inert in-process transports. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { BotEntryError, createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { CanonicalChatOrchestrator } from "../../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { MANAGED_PI_CHAT_SUPPORTS, managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { insertChat } from "./bot-state-support.js";
import { retainedThreadEntryFailure } from "./deployed-v9-entry-support.js";
import { BOT, OWNER, NOW, V9_THREAD, V9_PROJECT, createDeployedV9Fixture, v9PgEnabled,
  type DeployedV9Fixture } from "./deployed-v9-postgres-support.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
const capabilitySnapshot = { revision: "guard_pg_fixture", ...MANAGED_PI_CHAT_SUPPORTS };

describe.skipIf(!v9PgEnabled)("canonical thread guard on pooled PostgreSQL", () => {
  let fixture: DeployedV9Fixture | undefined;
  let orchestrator: CanonicalChatOrchestrator | undefined;
  beforeEach(async () => { fixture = await createDeployedV9Fixture(); });
  afterEach(async () => {
    try { if (orchestrator) { await orchestrator.drain(); await orchestrator.close(); } }
    finally { orchestrator = undefined; await fixture?.destroy(); fixture = undefined; }
  });

  function boundary() {
    let starts = 0, catalogs = 0;
    const adapter: CanonicalChatProviderAdapter = { driverKind: "matrix_pi", stateSchemaVersion: 1,
      parseState: value => value, serializeState: value => value,
      async *start() { starts += 1; yield { type: "run.completed", outcome: "completed" }; },
    };
    const agents = { get: async () => null };
    const botChats = createCustomBotChats({ chats: fixture!.chats, agents });
    orchestrator = new CanonicalChatOrchestrator({ repository: fixture!.chats,
      catalog: { getCatalog: async () => { catalogs += 1; return { revision: "guard_pg_fixture",
        drivers: [{ kind: "matrix_pi" as const, displayName: "Pi", adapterVersion: "1", capabilityClass: "system_agent" as const }],
        instances: managedPiChatInstances(makeAiProviderSnapshot()).map(instance => ({ ...instance, catalogRevision: "guard_pg_fixture" })),
      }; } }, adapters: new CanonicalChatProviderRegistry([adapter]),
      agentContext: new ChatAgentContext({ repository: fixture!.chats, agents, botChats, enabled: () => true }),
    });
    return { botChats, starts: () => starts, catalogs: () => catalogs };
  }

  async function seedRetainedQueue(chatId: string, key: string) {
    // Frozen historical queue state, seeded directly: no new user job or admission.
    await fixture!.db.insertInto("chat_queued_turns").values({
      id: `qturn_${key}`, chat_id: chatId, client_request_id: `req_${key}`, position: 1, status: "queued",
      parts: JSON.stringify([{ type: "text", text: "Synthetic retained queued request" }]),
      driver_kind: "matrix_pi", instance_id: selection.instanceId, selection: JSON.stringify(selection),
      interaction_mode: "default", permission_mode: "full_access", execution_root: null, execution_root_fingerprint: null,
      context_snapshot: null, capability_snapshot: JSON.stringify(capabilitySnapshot),
      claimed_turn_id: null, claimed_run_id: null, cancelled_at: null, created_at: NOW, updated_at: NOW,
    }).execute();
  }

  it("finds a live thread beyond sixteen older group bindings and keeps another account isolated", async () => {
    await fixture!.db.transaction().execute(async trx => {
      for (let index = 0; index < 16; index += 1) {
        await trx.insertInto("bot_chat_bindings").values({ owner_id: OWNER, bot_id: `bot_group${String(index).padStart(8, "0")}`,
          chat_id: V9_THREAD, kind: "group", project_id: null, created_at: "2026-09-26T12:00:00.000Z", removed_at: null }).execute();
      }
    });
    const listed = await createBotBindingsRepository(fixture!.db).forChat({ ownerId: OWNER, chatId: V9_THREAD });
    expect(listed).toHaveLength(16);
    expect(listed.every(binding => binding.kind === "group")).toBe(true);
    const before = await fixture!.snapshot(), b = boundary();
    await expect(b.botChats.directBot(owner, V9_THREAD)).rejects.toEqual(new BotEntryError("unavailable"));
    await expect(b.botChats.directBot({ type: "personal", ownerId: "user_other_guard_account" }, V9_THREAD)).resolves.toBeNull();
    expect(b.starts()).toBe(0); expect(b.catalogs()).toBe(0);
    expect(await fixture!.snapshot()).toEqual(before);
  });

  it.each(["missing", "history-only"] as const)("refuses retained Retry with %s context before a new run or provider", async scenario => {
    await seedRetainedQueue(V9_THREAD, "historical_retry_seed");
    const claimed = await fixture!.chats.claimNextQueuedTurn(owner, { chatId: V9_THREAD, turnId: "cturn_historical_guard",
      runId: "run_historical_guard", messageId: "msg_historical_guard", claimedAt: NOW });
    expect(claimed).not.toBeNull();
    await fixture!.chats.finishRun(owner, { chatId: V9_THREAD, runId: claimed!.run.id, outcome: "failed", completedAt: NOW });
    const context = scenario === "missing" ? null : JSON.stringify({ version: 1, requestHash: "a".repeat(64), chats: [],
      history: { chatId: V9_THREAD, title: "Historical fixture", throughSeq: 1, text: "Synthetic history", truncated: false } });
    await fixture!.db.updateTable("chat_runs").set({ context_snapshot: context }).where("id", "=", claimed!.run.id).execute();
    const runsBefore = await fixture!.db.selectFrom("chat_runs").selectAll().orderBy("id").execute();
    const before = await fixture!.snapshot(), b = boundary();
    const record = (await fixture!.chats.get(owner, V9_THREAD))!;
    const outcome = await orchestrator!.retryTurn({ userId: OWNER, source: "jwt" }, owner, V9_THREAD, claimed!.turn.id,
      { clientRequestId: `req_retry_${scenario}`, baseRevision: record.chat.revision })
      .then(() => ({ accepted: true as const }), retainedThreadEntryFailure);
    await orchestrator!.drain();
    expect({ outcome, starts: b.starts(), catalogs: b.catalogs(), runs: await fixture!.db.selectFrom("chat_runs").selectAll().orderBy("id").execute(),
      snapshot: await fixture!.snapshot() }).toEqual({ outcome: { accepted: false, errorType: "CanonicalChatOrchestrationError", code: "resource_unavailable", status: 503, retryable: false, recoveryActions: [] },
      starts: 0, catalogs: 0, runs: runsBefore, snapshot: before });
  });

  it("retains twenty rejected thread queues and starts ordinary Chat21 on the second bounded recovery pass", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `chat_pg_guard_${String(i).padStart(2, "0")}`);
    await fixture!.db.transaction().execute(async trx => {
      for (const [index, chatId] of ids.entries()) {
        await insertChat(trx, chatId);
        if (index < 20) await sql`INSERT INTO bot_chat_bindings (owner_id,bot_id,chat_id,kind,project_id,created_at,removed_at)
          VALUES (${OWNER},${BOT},${chatId},'thread',${V9_PROJECT},${NOW},NULL)`.execute(trx);
      }
    });
    for (const [index, chatId] of ids.entries()) await seedRetainedQueue(chatId, `page_${index}`);
    const beforeThreads = await fixture!.db.selectFrom("chat_queued_turns").selectAll().where("chat_id", "in", ids.slice(0, 20)).orderBy("id").execute();
    expect(await fixture!.chats.listQueuedChatIds(owner, 20)).toEqual(ids.slice(0, 20));
    expect(await fixture!.chats.listQueuedChatIds(owner, 20, ids[19])).toEqual([ids[20]]);
    const b = boundary();
    await expect(orchestrator!.reconcileActiveRuns(owner)).resolves.toBe(0);
    await orchestrator!.drain();
    expect(b.starts()).toBe(0);
    expect(await fixture!.db.selectFrom("chat_runs").select("id").execute()).toEqual([]);
    await expect(orchestrator!.reconcileActiveRuns(owner)).resolves.toBe(0);
    await orchestrator!.drain();
    expect(b.starts()).toBe(1);
    expect(await fixture!.db.selectFrom("chat_runs").select(["chat_id", "status"]).execute())
      .toEqual([{ chat_id: ids[20], status: "completed" }]);
    expect(await fixture!.db.selectFrom("chat_queued_turns").selectAll().where("chat_id", "in", ids.slice(0, 20)).orderBy("id").execute()).toEqual(beforeThreads);
  });
});
