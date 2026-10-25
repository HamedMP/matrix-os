import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createAuthorityFixture } from "./google-data/fixture-db.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createGoogleModelHistoryStore } from "../../packages/gateway/src/google-data/runtime/model-history.js";
import { createGoogleContextStore } from "../../packages/gateway/src/google-data/runtime/contexts.js";
import { createChatAnalyticsStore, createTransientChatClassifier } from "../../packages/gateway/src/chat-analytics/index.js";

const owner = { type: "personal" as const, ownerId: "owner_one" };
const binding = { ownerId: owner.ownerId, chatId: "chat_one", runId: "run_one", runtimeHandle: "runtime_one", executionGeneration: "1", requestId: "req_one" };
const tags = { taskFamily: "coding", taskType: "debug", complexity: "medium", confidence: 0.8 };
let now: Date;
let db: Awaited<ReturnType<typeof createAuthorityFixture>>["db"];
let repository: ChatRepository;
let history: ReturnType<typeof createGoogleModelHistoryStore>;
let store: ReturnType<typeof createChatAnalyticsStore>;

beforeEach(async () => {
  now = new Date(); ({ db } = await createAuthorityFixture());
  repository = new ChatRepository(db.sql); await repository.bootstrap();
  history = createGoogleModelHistoryStore(repository.kysely, { now: () => now }); await history.migrate();
  repository = new ChatRepository(repository.kysely, false, undefined, {
    onServerCreatedEmptyChat: (tx, subject, chatId, receipt) => history.recordServerCreatedEmptyChat(tx, subject, chatId, receipt),
  });
  await repository.create(owner, { id: "chat_one", clientRequestId: "req_create", title: "Private fixture" });
  await sql`INSERT INTO chat_messages(id,chat_id,seq,role,purpose,state,parts,byte_count,created_at)
    VALUES('msg_one','chat_one',1,'user','ai_request','committed','[]'::jsonb,0,${now})`.execute(repository.kysely);
  await sql`INSERT INTO chat_turns(id,chat_id,client_request_id,base_message_seq,input_message_id,status,created_at,updated_at)
    VALUES('turn_one','chat_one','req_turn',0,'msg_one','running',${now},${now})`.execute(repository.kysely);
  await sql`INSERT INTO chat_runs(id,chat_id,turn_id,client_request_id,attempt,driver_kind,instance_id,selection,
    interaction_mode,permission_mode,status,history_boundary_seq,capability_snapshot,created_at,updated_at)
    VALUES('run_one','chat_one','turn_one','req_run',1,'matrix_pi','matrix_pi_default','{}'::jsonb,
      'chat','default','running',1,'{}'::jsonb,${now},${now})`.execute(repository.kysely);
  store = createChatAnalyticsStore(repository.kysely, { now: () => now }); await store.migrate();
});

async function record(extraFacts: Record<string, unknown> = {}) {
  await store.configureOwner(owner.ownerId, { enabled: true, sampleRateBps: 10_000 });
  const lease = await store.inspectAdmission(binding); expect(lease).toBeTruthy();
  return { generationId: randomUUID(), binding, lease: lease!, capturedAt: now.toISOString(), sampled: true,
    facts: { completedAt: now.toISOString(), modelId: "measured-model", harness: "matrix_pi", accessSource: "matrix_included",
      inputTokens: 12, outputTokens: 4, cachedInputTokens: null, costUsd: 0.001, latencyMs: 20, ...extraFacts } };
}
const range = () => ({ ownerId: owner.ownerId, from: new Date(now.getTime() - 1000).toISOString(),
  to: new Date(now.getTime() + 1000).toISOString(), groupBy: ["taskFamily"] as const, includeUnclassified: true });

describe("owner PostgreSQL Chat analytics", () => {
  it("returns only display-safe owner policy without private admission epochs", async () => {
    expect(await store.getOwnerPolicy(owner.ownerId)).toBeNull();
    await store.configureOwner(owner.ownerId, { enabled: true, sampleRateBps: 500 });
    expect(await store.getOwnerPolicy(owner.ownerId)).toEqual({ enabled: true, sampleRateBps: 500 });
    expect(await store.getOwnerPolicy("outsider")).toBeNull();
  });
  it("requires explicit policy, real server birth and exact durable owner/run binding", async () => {
    expect(await store.inspectAdmission(binding)).toBeNull();
    await store.configureOwner(owner.ownerId, { enabled: true, sampleRateBps: 10_000 });
    expect(await store.inspectAdmission(binding)).toBeTruthy();
    expect(await store.inspectAdmission({ ...binding, ownerId: "outsider" })).toBeNull();
    expect(await store.inspectAdmission({ ...binding, runId: "run_missing" })).toBeNull();
    await sql`DELETE FROM google_model_history_births WHERE chat_id='chat_one'`.execute(repository.kysely);
    expect(await store.inspectAdmission(binding)).toBeNull();
  });
  it("persists only measured metadata and fixed tags, with idempotent correlation", async () => {
    const completed = await record();
    expect(await store.recordCompleted(completed)).toBe(true);
    expect(await store.recordCompleted(completed)).toBe(true);
    expect(await store.recordCompleted({ ...completed, generationId: randomUUID() })).toBe(false);
    expect(await store.commitTags(completed, tags)).toBe(true);
    const rows = await sql`SELECT * FROM chat_analytics_generations`.execute(repository.kysely);
    expect(rows.rows).toHaveLength(1);
    const columns = await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns
      WHERE table_name='chat_analytics_generations' AND table_schema=current_schema()`.execute(repository.kysely);
    expect(columns.rows.some(x => /prompt|response|snapshot|content|reason|entit|payload/.test(x.column_name))).toBe(false);
    const buckets = await store.aggregate(range());
    expect(buckets).toEqual([expect.objectContaining({ generations: 1, classified: 1, costUsd: 0.001, inputTokens: 12 })]);
    expect(await store.aggregate({ ...range(), ownerId: "outsider" })).toEqual([]);
    expect((await sql`SELECT 1 AS alive`.execute(repository.kysely)).rows).toHaveLength(1);
  });
  it("preserves unknown usage and bounded analytics dimensions/ranges", async () => {
    const completed = await record({ modelId: null, harness: null, accessSource: null, inputTokens: null, outputTokens: null, costUsd: null, latencyMs: null });
    expect(await store.recordCompleted(completed)).toBe(true);
    expect(await store.aggregate(range())).toEqual([expect.objectContaining({ generations: 1, classified: 0, costUsd: null,
      inputTokens: null, unknownCostGenerations: 1, unknownInputTokenGenerations: 1 })]);
    await expect(store.aggregate({ ...range(), groupBy: ["prompt"] } as never)).rejects.toThrow();
    await expect(store.aggregate({ ...range(), from: new Date(now.getTime() - 32 * 86_400_000).toISOString() })).rejects.toThrow();
  });
  it("retains a legitimate completed generation after normal run completion but denies cancellation", async () => {
    const completed = await record();
    await sql`UPDATE chat_runs SET status='completed',outcome='completed',completed_at=${now} WHERE id='run_one'`.execute(repository.kysely);
    expect(await store.recordCompleted(completed)).toBe(true);
    expect(await store.revalidateGeneration(completed)).toBe(true);
    await sql`UPDATE chat_runs SET status='aborted',outcome='aborted' WHERE id='run_one'`.execute(repository.kysely);
    expect(await store.revalidateGeneration(completed)).toBe(false);
    expect(await store.commitTags(completed, tags)).toBe(false);
  });
  it("rotates Chat deletion epochs so a late completion cannot recreate deleted analytics", async () => {
    const completed = await record(); expect(await store.recordCompleted(completed)).toBe(true);
    await store.deleteChat(owner.ownerId, "chat_one");
    expect(await store.recordCompleted(completed)).toBe(false);
    expect(await store.commitTags(completed, tags)).toBe(false);
    expect(await store.aggregate(range())).toEqual([]);
    expect((await store.inspectAdmission(binding))?.chatEpoch).not.toBe(completed.lease.chatEpoch);
  });
  it("removes owner data and prevents a fresh enable from reviving old receipts", async () => {
    const completed = await record(); expect(await store.recordCompleted(completed)).toBe(true);
    await store.deleteOwner(owner.ownerId);
    for (const table of ["chat_analytics_generations", "chat_analytics_scopes", "chat_analytics_owner_policy"]) {
      expect((await sql<{ count: number }>`SELECT count(*)::int AS count FROM ${sql.table(table)}`.execute(repository.kysely)).rows[0].count).toBe(0);
    }
    await store.configureOwner(owner.ownerId, { enabled: true, sampleRateBps: 10_000 });
    expect(await store.recordCompleted(completed)).toBe(false);
    expect((await store.inspectAdmission(binding))?.ownerEpoch).not.toBe(completed.lease.ownerEpoch);
  });
  it("does not hold the global context lock across a classifier request and discards later Google taint", async () => {
    await store.configureOwner(owner.ownerId, { enabled: true, sampleRateBps: 10_000 });
    let release!: (value: unknown) => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const service = createTransientChatClassifier({ enabled: true, store, now: () => now.getTime(),
      classify: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
    try {
      const capture = await service.capture({ binding, api: "openai-completions", body: JSON.stringify({ messages: [{ role: "user", content: "ordinary task fixture" }] }) });
      service.completed(capture!, { completedAt: now.toISOString() }); await started;
      // This must commit while the model promise is still pending.
      await createGoogleContextStore(repository.kysely, { now: () => now }).mark({ ownerId: owner.ownerId, chatId: "chat_one",
        googleAccountId: "10000000-0000-4000-8000-000000000001", consentId: "consent_one", profileId: "profile_one", profileRevision: 1,
        purposeId: "assistant", expiresAt: new Date(now.getTime() + 60_000).toISOString(), retentionDeadline: new Date(now.getTime() + 60_000).toISOString() });
      release(tags); await service.whenIdle();
      expect((await sql`SELECT 1 FROM chat_analytics_generations WHERE classified_at IS NOT NULL`.execute(repository.kysely)).rows).toHaveLength(0);
      expect(await store.aggregate(range())).toEqual([]);
    } finally { release?.(tags); await service.close(); }
  });
  it("accepts Chat cleanup after actual hard deletion without recreating a scope", async () => {
    const completed = await record(); expect(await store.recordCompleted(completed)).toBe(true);
    await sql`DELETE FROM chats WHERE id='chat_one' AND owner_id=${owner.ownerId}`.execute(repository.kysely);
    await store.deleteChat(owner.ownerId, "chat_one");
    expect((await sql`SELECT 1 FROM chat_analytics_scopes WHERE chat_id='chat_one'`.execute(repository.kysely)).rows).toHaveLength(0);
    expect((await sql`SELECT 1 FROM chat_analytics_generations WHERE chat_id='chat_one'`.execute(repository.kysely)).rows).toHaveLength(0);
  });
  it("expires metadata under bounded cleanup and supports idempotent migration", async () => {
    const completed = await record(); expect(await store.recordCompleted(completed)).toBe(true);
    await store.migrate();
    now = new Date(now.getTime() + 31 * 86_400_000); await store.expire();
    expect((await sql`SELECT 1 FROM chat_analytics_generations`.execute(repository.kysely)).rows).toHaveLength(0);
  });
});
