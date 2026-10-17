import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapBrowserApprovalMetadata } from "../../packages/gateway/src/chat/browser-approval-database.js";
import { BrowserApprovalRepository } from "../../packages/gateway/src/chat/browser-approval-repository.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import type { BrowserDecisionProof, BrowserDecisionTuple } from "@matrix-os/contracts";

/** Root must supply a disposable PostgreSQL URL. A skipped suite is not acceptance. */
describe.runIf(Boolean(process.env.MATRIX_TEST_POSTGRES_URL))("owner PostgreSQL browser authority", () => {
  let admin: Kysely<ChatDatabase>, db: Kysely<ChatDatabase>, repository: BrowserApprovalRepository, schema: string;
  const ownerId = "owner_one", chatId = "chat_one", runId = "run_one";
  let currentTime: number;
  function tuple(approvalId: string, browserDecision: BrowserDecisionTuple["browserDecision"] = "allow_once"): BrowserDecisionTuple {
    return { handle: "pr-1234", runtimeSlot: "pr-1234", actorId: ownerId, chatId, runId, approvalId, clientRequestId: `req_${approvalId}`,
      browserDecision, actionDigest: "a".repeat(64), leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 };
  }
  const identity = (id: string) => ({ ownerId, chatId, runId, approvalId: id, leaseEpoch: tuple(id).leaseEpoch, actionDigest: "a".repeat(64), challengeRevision: 0, scopeVersion: 1 as const });
  beforeEach(async () => {
    currentTime = Date.now(); schema = `browser_test_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely<ChatDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.MATRIX_TEST_POSTGRES_URL, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 5000 }) }) });
    await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
    db = new Kysely<ChatDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.MATRIX_TEST_POSTGRES_URL, max: 4,
      connectionTimeoutMillis: 2000, statement_timeout: 5000, options: `-c search_path=${schema}` }) }) });
    await sql`CREATE TABLE chats(id TEXT PRIMARY KEY, owner_type TEXT, owner_id TEXT, lifecycle TEXT, collaboration JSONB)`.execute(db);
    await sql`CREATE TABLE chat_runs(id TEXT PRIMARY KEY, chat_id TEXT REFERENCES chats(id), status TEXT)`.execute(db);
    await sql`INSERT INTO chats VALUES(${chatId},'personal',${ownerId},'active',NULL)`.execute(db);
    await sql`INSERT INTO chat_runs VALUES(${runId},${chatId},'running')`.execute(db);
    await bootstrapBrowserApprovalMetadata(db);
    repository = new BrowserApprovalRepository(db, { boundedConnectionAcquisition: true, now: () => currentTime, verifyDecision: async (expected, proof) => {
      if (proof !== "verified-owner-fixture") throw new Error("Browser approval unavailable");
      return { ...expected, version: 1, bodyDigest: "b".repeat(64), nonce: randomUUID().replaceAll("-", ""), expiresAt: currentTime + 60_000 } satisfies BrowserDecisionProof;
    }, verifyRevoke: async expected => ({ ...expected, version: 1, operation: "revoke_grant", bodyDigest: "c".repeat(64), nonce: randomUUID().replaceAll("-", ""), expiresAt: currentTime + 60_000 }) });
  });
  afterEach(async () => { await repository?.close(); await db?.destroy(); if (admin) { await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin); await admin.destroy(); } });

  it("atomically permits one decision and one exact consumption; rejects forged proof and tuple changes", async () => {
    await repository.reserve(identity("approval_one"), currentTime + 60_000);
    await expect(repository.decide(tuple("approval_one"), "forged")).rejects.toThrow();
    const decisions = await Promise.allSettled([repository.decide(tuple("approval_one"), "verified-owner-fixture"), repository.decide(tuple("approval_one"), "verified-owner-fixture")]);
    expect(decisions.filter(result => result.status === "fulfilled")).toHaveLength(2); // one success, one idempotent acknowledgement
    await expect(repository.consume({ ...identity("approval_one"), actionDigest: "d".repeat(64) })).rejects.toThrow();
    const consumed = await Promise.allSettled([repository.consume(identity("approval_one")), repository.consume(identity("approval_one"))]);
    expect(consumed.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const data = await sql<{ count: string }>`SELECT count(*)::text AS count FROM browser_chat_decisions`.execute(db);
    expect(data.rows[0]?.count).toBe("1");
  });
  it("keeps both approvals executable when pending actions receive the same active Chat grant", async () => {
    await repository.reserve(identity("grant_first"), currentTime + 60_000);
    await repository.reserve(identity("grant_second"), currentTime + 60_000);
    const first = await repository.decide(tuple("grant_first", "allow_in_chat"), "verified-owner-fixture");
    const second = await repository.decide(tuple("grant_second", "allow_in_chat"), "verified-owner-fixture");
    expect(second.grant).toMatchObject({ id: first.grant!.id, revision: first.grant!.revision });
    await repository.consume(identity("grant_first"));
    await repository.consume(identity("grant_second"));
  });
  it("creates a Chat-only grant with the decision, and Undo fences approved-but-unconsumed work", async () => {
    await repository.reserve(identity("approval_two"), currentTime + 60_000);
    const result = await repository.decide(tuple("approval_two", "allow_in_chat"), "verified-owner-fixture");
    expect(result.grant).toMatchObject({ chatId, state: "active", capability: "shared_chrome", revision: 1 });
    expect(await repository.activeGrant(ownerId, "other_chat")).toBeNull();
    await repository.revoke({ handle: "pr-1234", runtimeSlot: "pr-1234", actorId: ownerId, chatId, grantId: result.grant!.id, clientRequestId: "req_undo", baseRevision: 1 }, "owner-revoke-fixture");
    expect(await repository.activeGrant(ownerId, chatId)).toBeNull();
    await expect(repository.consume(identity("approval_two"))).rejects.toThrow();
    expect((await sql`SELECT * FROM browser_chat_grants`.execute(db)).rows).not.toEqual([]);
  });
  it("consumes only an exact pending call under the current grant revision and idempotently acknowledges fresh-proof retries", async () => {
    await repository.reserve(identity("grant_origin"), currentTime + 60_000);
    const decision = tuple("grant_origin", "allow_in_chat");
    const granted = await repository.decide(decision, "verified-owner-fixture");
    expect(await repository.decide(decision, "verified-owner-fixture")).toMatchObject({ alreadySubmitted: true, grant: { revision: 1 } });
    await repository.consume(identity("grant_origin"));
    await repository.reserve(identity("grant_next"), currentTime + 60_000);
    await expect(repository.consumeGrant(identity("grant_next"), granted.grant!.id, 2)).rejects.toThrow();
    const consumed = await Promise.allSettled([repository.consumeGrant(identity("grant_next"), granted.grant!.id, 1), repository.consumeGrant(identity("grant_next"), granted.grant!.id, 1)]);
    expect(consumed.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const undo = { handle: "pr-1234", runtimeSlot: "pr-1234", actorId: ownerId, chatId, grantId: granted.grant!.id, clientRequestId: "req_undo_retry", baseRevision: 1 };
    await repository.revoke(undo, "owner-revoke-fixture");
    expect(await repository.revoke(undo, "fresh-owner-revoke-fixture")).toMatchObject({ state: "revoked", revision: 2 });
    await repository.reserve(identity("grant_revoked"), currentTime + 60_000);
    await expect(repository.consumeGrant(identity("grant_revoked"), granted.grant!.id, 1)).rejects.toThrow();
  });
  it("cleanup skips a locked revoked grant and preserves its concurrent reactivation", async () => {
    await repository.reserve(identity("cleanup_origin"), currentTime + 60_000);
    const original = await repository.decide(tuple("cleanup_origin", "allow_in_chat"), "verified-owner-fixture");
    const id = original.grant!.id;
    await repository.revoke({ handle: "pr-1234", runtimeSlot: "pr-1234", actorId: ownerId, chatId, grantId: id,
      clientRequestId: "req_cleanup_revoke", baseRevision: 1 }, "owner-revoke-fixture");
    await sql`UPDATE browser_chat_grants SET revoked_at=${new Date(currentTime - 25 * 60 * 60_000)} WHERE id=${id}::uuid`.execute(db);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(yes => { release = yes; });
    const acquired = new Promise<void>(yes => { locked = yes; });
    const reactivation = db.transaction().execute(async trx => {
      await sql`SELECT id FROM browser_chat_grants WHERE id=${id}::uuid FOR UPDATE`.execute(trx);
      locked(); await gate;
      await sql`UPDATE browser_chat_grants SET state='active',revision=3,revoked_at=NULL WHERE id=${id}::uuid`.execute(trx);
    });
    let sweep: Promise<void> | undefined;
    try {
      await Promise.race([acquired, reactivation]);
      let swept = false; sweep = repository.sweep().then(() => { swept = true; });
      // A maintenance sweep must skip a busy grant instead of waiting on the
      // owner's transaction and later deleting the newly active tuple.
      await vi.waitFor(() => expect(swept).toBe(true), { timeout: 1500 });
    } finally { release(); await reactivation; await sweep; }
    expect(await repository.activeGrant(ownerId, chatId)).toMatchObject({ id, state: "active", revision: 3 });
  });

  it("bounds retained tombstones even when cancellation precedes challenge registration", async () => {
    await Promise.all(Array.from({ length: 16 }, () => repository.invalidateLease(ownerId, randomUUID())));
    for (let index = 16; index < 256; index++) await repository.invalidateLease(ownerId, randomUUID());
    await expect(repository.invalidateLease(ownerId, randomUUID())).rejects.toThrow();
    expect((await sql<{ count: string }>`SELECT count(*)::text AS count FROM browser_chat_leases WHERE owner_id=${ownerId}`.execute(db)).rows[0]?.count).toBe("256");
  });
  it("denial, expiry, epoch invalidation and foreign/private-scope mismatches never become executable", async () => {
    for (const [id, decision] of [["approval_deny", "not_now"], ["approval_cancel", "cancel"]] as const) {
      await repository.reserve(identity(id), currentTime + 60_000); await repository.decide(tuple(id, decision), "verified-owner-fixture");
      await expect(repository.consume(identity(id))).rejects.toThrow();
    }
    await expect(repository.reserve({ ...identity("foreign"), ownerId: "foreign" }, currentTime + 60_000)).rejects.toThrow();
    await repository.reserve(identity("approval_epoch"), currentTime + 60_000);
    await repository.invalidateLease(ownerId, tuple("approval_epoch").leaseEpoch);
    await expect(repository.decide(tuple("approval_epoch"), "verified-owner-fixture")).rejects.toThrow();
    await expect(repository.reserve(identity("old_epoch_reuse"), currentTime + 60_000)).rejects.toThrow();
    const expiredIdentity = { ...identity("approval_expired"), leaseEpoch: "378ca19d-9760-4e67-a221-62bedf393b90" };
    await repository.reserve(expiredIdentity, currentTime + 1000); currentTime += 1001;
    await expect(repository.decide({ ...tuple("approval_expired"), leaseEpoch: expiredIdentity.leaseEpoch }, "verified-owner-fixture")).rejects.toThrow();
    await repository.sweep();
    const expired = await sql<{ status: string }>`SELECT status FROM browser_chat_challenges WHERE id='approval_expired'`.execute(db);
    expect(expired.rows[0]?.status).toBe("expired");
  });
  it("caps owner/Run pending admission and drains only its own work on close", async () => {
    await Promise.all(Array.from({ length: 16 }, (_, index) => repository.reserve(identity(`cap_${index}`), currentTime + 60_000)));
    await expect(repository.reserve(identity("cap_overflow"), currentTime + 60_000)).rejects.toThrow();
    await repository.reserve(identity("cap_0"), currentTime + 60_000); // idempotent even at the cap
    await repository.close(); await expect(repository.activeGrant(ownerId, chatId)).rejects.toThrow();
    expect((await sql<{ alive: number }>`SELECT 1 AS alive`.execute(db)).rows[0]?.alive).toBe(1);
  });
});
