import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_SESSION_MAX_BYTES, createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { admitSessionRun } from "./shared-session-run-support.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OTHER_OWNER, OWNER, at, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
const key = { ownerId: OWNER, botId: BOT, chatId: "chat_session1" };
const versions = { "@earendil-works/pi-agent-core": "0.86.1", bundle: "sha256-abc" };

beforeEach(async () => {
  ({ db, destroy } = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase()));
  await insertChat(db, "chat_session1");
});
afterEach(async () => destroy());

describe("bot sessions repository", () => {
  it("loads an empty session at revision 0 and saves revision-checked", async () => {
    const repo = createBotSessionsRepository(db);
    await expect(repo.load(key)).resolves.toMatchObject({ revision: 0, messages: [], needsRecompaction: false });
    const messages = [{ role: "user", content: "hi", timestamp: 1 }];
    await expect(repo.save({ ...key, baseRevision: 0, messages, tokenEstimate: 3, runtimeVersions: versions, now: NOW }))
      .resolves.toEqual({ revision: 1 });
    // A second creator loses.
    await expect(repo.save({ ...key, baseRevision: 0, messages, tokenEstimate: 3, runtimeVersions: versions, now: NOW }))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    const next = [...messages, { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 }];
    await expect(repo.save({ ...key, baseRevision: 1, messages: next, tokenEstimate: 9, runtimeVersions: versions, now: at(1) }))
      .resolves.toEqual({ revision: 2 });
    await expect(repo.save({ ...key, baseRevision: 1, messages, tokenEstimate: 3, runtimeVersions: versions, now: at(2) }))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    await expect(repo.load(key)).resolves.toMatchObject({ revision: 2, messages: next });
    await expect(repo.load({ ...key, ownerId: OTHER_OWNER })).resolves.toMatchObject({ revision: 0, messages: [] });
  });

  it("resets shared transcripts on policy/root context change and fences stale saves", async () => {
    const repo = createBotSessionsRepository(db);
    const old = { ...key, contextGeneration: "a".repeat(64), contextRunId: "run_old" };
    const oldRun = await admitSessionRun(db, OWNER, key.chatId, old.contextRunId);
    await repo.save({ ...old, baseRevision: 0, messages: [{ role: "user", content: "OLD POLICY EVIDENCE" }], tokenEstimate: 10, runtimeVersions: versions, now: NOW });
    expect((await repo.load(old)).messages).toHaveLength(1);
    await expect(repo.load(key)).rejects.toMatchObject({ code: "not_found" });
    const next = { ...key, contextGeneration: "b".repeat(64), contextRunId: "run_new" };
    await oldRun.complete(); await admitSessionRun(db, OWNER, key.chatId, next.contextRunId);
    const snapshot = await repo.load(next);
    expect(snapshot).toMatchObject({ revision: 2, messages: [], compactedThroughSeq: null });
    await expect(repo.save({ ...old, baseRevision: 2, messages: [{ role: "assistant", content: "STALE" }], tokenEstimate: 1, runtimeVersions: versions, now: NOW })).rejects.toMatchObject({ code: "not_found" });
    await repo.save({ ...next, baseRevision: 2, messages: [{ role: "user", content: "NEW POLICY" }], tokenEstimate: 1, runtimeVersions: versions, now: NOW });
    expect((await repo.load(next)).messages[0]?.content).toBe("NEW POLICY");
  });

  it("cannot reset a newer shared transcript when an older canonical run loads again", async () => {
    const repo = createBotSessionsRepository(db);
    const old = { ...key, contextGeneration: "a".repeat(64), contextRunId: "run_old" };
    const next = { ...key, contextGeneration: "b".repeat(64), contextRunId: "run_new" };
    const oldRun = await admitSessionRun(db, OWNER, key.chatId, old.contextRunId);
    await repo.save({ ...old, baseRevision: 0, messages: [{ content: "old evidence" }], tokenEstimate: 1, runtimeVersions: versions, now: NOW });
    await oldRun.complete(); await admitSessionRun(db, OWNER, key.chatId, next.contextRunId);
    const reset = await repo.load(next);
    await repo.save({ ...next, baseRevision: reset.revision, messages: [{ content: "new evidence" }], tokenEstimate: 1, runtimeVersions: versions, now: NOW });
    const current = await repo.load(next);
    await expect(repo.load(old)).rejects.toMatchObject({ code: "not_found" });
    expect(await repo.load(next)).toEqual(current);
    await expect(repo.load({ ...next, contextGeneration: "c".repeat(64) })).rejects.toMatchObject({ code: "not_found" });
    expect(await repo.load(next)).toEqual(current);
  });

  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("checks stale shared loads after acquiring the canonical Chat lock", async () => {
    const repo = createBotSessionsRepository(db), old = { ...key, contextGeneration: "a".repeat(64), contextRunId: "run_old" }, next = { ...key, contextGeneration: "b".repeat(64), contextRunId: "run_new" };
    const oldRun = await admitSessionRun(db, OWNER, key.chatId, old.contextRunId);
    await repo.save({ ...old, baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: NOW });
    await oldRun.complete(); await admitSessionRun(db, OWNER, key.chatId, next.contextRunId);
    const reset = await repo.load(next);
    await repo.save({ ...next, baseRevision: reset.revision, messages: [{ content: "new evidence" }], tokenEstimate: 1, runtimeVersions: versions, now: NOW });
    const expected = await repo.load(next);
    let release!: () => void, locked!: () => void, holderPid = 0;
    const acquired = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction().execute(async trx => { await trx.selectFrom("chats").select("id").where("id", "=", key.chatId).forUpdate().execute(); holderPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0].pid; locked(); await gate; });
    await acquired;
    let settled = false; const stale = repo.load(old).then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
    try {
      await vi.waitFor(async () => { const waiters = await sql<{ waiting: string }>`SELECT count(*)::text AS waiting FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`.execute(db); expect(Number(waiters.rows[0].waiting)).toBeGreaterThan(0); });
      expect(settled).toBe(false);
    } finally { release(); await holder; }
    expect(await stale).toMatchObject({ error: { code: "not_found" } }); expect(await repo.load(next)).toEqual(expected);
  });

  it("requires paired trusted shared context and exact active matrix_bot authority", async () => {
    const repo = createBotSessionsRepository(db), shared = { ...key, contextGeneration: "a".repeat(64), contextRunId: "run_active" };
    await expect(repo.load({ ...key, contextGeneration: shared.contextGeneration })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.load({ ...key, contextRunId: shared.contextRunId })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.load({ ...shared, contextRunId: "invalid" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.load({ ...shared, ownerId: OTHER_OWNER })).rejects.toMatchObject({ code: "not_found" });
    await expect(repo.load(shared)).rejects.toMatchObject({ code: "not_found" });
    const run = await admitSessionRun(db, OWNER, key.chatId, shared.contextRunId);
    const input = { ...shared, baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: NOW };
    await expect(repo.save({ ...input, runtimeVersions: { "matrix-session-run": "run_active" } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.save({ ...input, contextGeneration: undefined })).rejects.toMatchObject({ code: "invalid_input" });
    await run.complete(); await expect(repo.save(input)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses oversized transcripts and unsafe runtime version records", async () => {
    const repo = createBotSessionsRepository(db);
    const huge = [{ role: "user", content: "x".repeat(BOT_SESSION_MAX_BYTES), timestamp: 1 }];
    await expect(repo.save({ ...key, baseRevision: 0, messages: huge, tokenEstimate: 1, runtimeVersions: versions, now: NOW }))
      .rejects.toEqual(new BotStateError("too_large"));
    await expect(repo.save({ ...key, baseRevision: 0, messages: [], tokenEstimate: 1, runtimeVersions: { "bad key": "1" }, now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_input"));
  });

  it("rejects invalid shared context hashes and nonintegral or negative token counts before persistence", async () => {
    const repo = createBotSessionsRepository(db);
    const input = { ...key, baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: NOW };
    await expect(repo.load({ ...key, contextGeneration: "invalid" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.save({ ...input, contextGeneration: "invalid" })).rejects.toMatchObject({ code: "invalid_input" });
    for (const tokenEstimate of [-1, 0.5, Number.NaN]) await expect(repo.save({ ...input, tokenEstimate })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(repo.load(key)).resolves.toMatchObject({ revision: 0 });
  });

  it("decodes legacy JSON string transcripts and refuses to expose malformed nonarray messages", async () => {
    const repo = createBotSessionsRepository(db), messages = [{ content: "legacy owner transcript" }];
    await repo.save({ ...key, baseRevision: 0, messages, tokenEstimate: 1, runtimeVersions: versions, now: NOW });
    // Some database drivers return raw JSON strings instead of decoded arrays.
    const driverJson: KyselyPlugin = { transformQuery: ({ node }) => node, transformResult: async ({ result }) => ({ ...result, rows: result.rows.map(row => ({ ...row, messages: JSON.stringify(row.messages), runtime_versions: JSON.stringify(row.runtime_versions) })) }) };
    await expect(createBotSessionsRepository(db.withPlugin(driverJson)).load(key)).resolves.toMatchObject({ revision: 1, messages });
    const malformedDriverJson: KyselyPlugin = { transformQuery: ({ node }) => node, transformResult: async ({ result }) => ({ ...result, rows: result.rows.map(row => ({ ...row, messages: { privateMalformedRecord: true } })) }) };
    await expect(createBotSessionsRepository(db.withPlugin(malformedDriverJson)).load(key)).resolves.toMatchObject({ revision: 1, messages: [] });
  });

  it("preserves database failures instead of masking them as an ownership miss", async () => {
    const repo = createBotSessionsRepository(db);
    await expect(repo.save({ ...key, baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: "invalid-timestamp" })).rejects.not.toBeInstanceOf(BotStateError);
    await expect(repo.load(key)).resolves.toMatchObject({ revision: 0 });
  });

  it("flags transcripts for recompaction so a stale copy cannot save over the flag", async () => {
    const repo = createBotSessionsRepository(db);
    await repo.save({ ...key, baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: NOW });
    await expect(repo.markNeedsRecompaction({ ownerId: OWNER, botId: BOT, now: at(1) })).resolves.toBe(1);
    await expect(repo.markNeedsRecompaction({ ownerId: OWNER, botId: BOT, now: at(2) })).resolves.toBe(1);
    // A worker that loaded revision 1 before the flag cannot save or clear it.
    await expect(repo.save({ ...key, baseRevision: 1, messages: [], tokenEstimate: 0, compactedThroughSeq: 9, runtimeVersions: versions, now: at(3) }))
      .rejects.toEqual(new BotStateError("revision_conflict"));
    await expect(repo.load(key)).resolves.toMatchObject({ revision: 3, needsRecompaction: true });
    await repo.save({ ...key, baseRevision: 3, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: at(4) });
    await expect(repo.load(key)).resolves.toMatchObject({ needsRecompaction: true });
    await repo.save({ ...key, baseRevision: 4, messages: [], tokenEstimate: 0, compactedThroughSeq: 40, runtimeVersions: versions, now: at(5) });
    await expect(repo.load(key)).resolves.toMatchObject({ needsRecompaction: false, compactedThroughSeq: 40, revision: 5 });
  });

  it("advances the revision for a second forget while an invalidated worker is running", async () => {
    const repo = createBotSessionsRepository(db);
    await repo.save({ ...key, baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: NOW });
    await repo.markNeedsRecompaction({ ownerId: OWNER, botId: BOT, now: at(1) });
    const loaded = await repo.load(key);
    await repo.markNeedsRecompaction({ ownerId: OWNER, botId: BOT, now: at(2) });
    await expect(repo.save({ ...key, baseRevision: loaded.revision, messages: [], tokenEstimate: 0,
      compactedThroughSeq: 0, runtimeVersions: versions, now: at(3) })).rejects.toEqual(new BotStateError("revision_conflict"));
  });

  it("refuses a transcript for a chat the owner does not own", async () => {
    await insertChat(db, "chat_foreign2", OTHER_OWNER);
    await expect(createBotSessionsRepository(db).save({
      ...key, chatId: "chat_foreign2", baseRevision: 0, messages: [], tokenEstimate: 0, runtimeVersions: versions, now: NOW,
    })).rejects.toEqual(new BotStateError("not_found"));
  });
});
