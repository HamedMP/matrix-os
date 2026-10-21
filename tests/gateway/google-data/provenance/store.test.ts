import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { boundedProvenanceTransaction } from "../../../../packages/gateway/src/google-data/provenance/transaction.js";
import { createGoogleProvenanceStore, type RecordGoogleCopy, type PurgeHandlers } from "../../../../packages/gateway/src/google-data/provenance/index.js";

const suite = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const owner = "owner_one";
const connection = "gmail_one";
const digest = "a".repeat(64);
const binding = { profileId: "profile_one", profileRevision: 1, purpose: "assistant" };
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();
const copy = (extra: Partial<RecordGoogleCopy> = {}): RecordGoogleCopy => ({
  ownerId: owner, kind: "chat", entityRef: "chat_one", contentHash: digest,
  origins: [{ connectionId: connection, ...binding }],
  retention: { choice: "until", deadline: tomorrow(), decisionId: "owner_choice_one" }, ...extra,
});

suite("durable Google provenance and conservative purge", () => {
  let db: Kysely<Record<string, never>>;
  let admin: Kysely<Record<string, never>>;
  let schema: string;
  let store: ReturnType<typeof createGoogleProvenanceStore>;
  beforeEach(async () => {
    const connectionString = process.env.MATRIX_TEST_POSTGRES_URL!;
    if (!new URL(connectionString).pathname.includes("test")) throw new Error("Dedicated test database required");
    schema = `provenance_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 10, options: `-c search_path=${schema} -c statement_timeout=5000` }) }) });
    store = createGoogleProvenanceStore(db);
    await store.migrate();
  });
  afterEach(async () => {
    if (db) await db.destroy();
    if (admin) { await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); }
  });
  it("persists exact owner lineage and requires every mixed-origin binding", async () => {
    await store.record(copy());
    await store.record(copy({ origins: [{ connectionId: "gmail_two", profileId: "byo_profile", profileRevision: 2, purpose: "assistant" }] }));
    const reopened = createGoogleProvenanceStore(db);
    const value = await reopened.inspect(owner, "chat", "chat_one");
    expect(value?.origins).toHaveLength(2);
    expect(await reopened.inspect("outsider", "chat", "chat_one")).toBeNull();
    await expect(reopened.assertReadable(owner, "chat", "chat_one", [{ connectionId: connection, ...binding }])).rejects.toThrow("Google data unavailable");
    await expect(reopened.assertReadable(owner, "chat", "chat_one", value!.origins)).resolves.toBeDefined();
  });
  it("does not clear old origins on content updates and retains the earliest deadline", async () => {
    const deadline = tomorrow();
    const first = await store.record(copy({ retention: { choice: "until", deadline, decisionId: "decision" } }));
    const next = await store.record(copy({ contentHash: "b".repeat(64), origins: [{ connectionId: "gmail_two", ...binding }], retention: { choice: "until", deadline: new Date(Date.now() + 172_800_000).toISOString(), decisionId: "later" }, baseRevision: first.revision }));
    expect(next.origins).toHaveLength(2);
    expect(next.retentionDeadline).toBe(deadline);
    expect(next.contentHash).toBe("b".repeat(64));
  });
  it("enforces conditional content updates under concurrency", async () => {
    const first = await store.record(copy());
    const outcomes = await Promise.allSettled([store.record(copy({ baseRevision: first.revision, contentHash: "b".repeat(64) })), store.record(copy({ baseRevision: first.revision, contentHash: "c".repeat(64) }))]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("requires explicit bounded retention and opaque references", async () => {
    await expect(store.record(copy({ entityRef: "../../secret" }))).rejects.toThrow();
    await expect(store.record(copy({ retention: undefined as never }))).rejects.toThrow();
    await expect(store.record(copy({ contentHash: "raw-content" }))).rejects.toThrow();
    await expect(store.record(copy({ retention: { choice: "until", deadline: "2999-01-01T00:00:00.000Z", decisionId: "x" } }))).rejects.toThrow();
    await expect(store.record(copy({ origins: [] }))).rejects.toThrow();
  });
  it("idempotently requests exact-account purge and blocks new reads and writes", async () => {
    await store.record(copy());
    await store.record(copy({ ownerId: "outsider" }));
    await store.record(copy({ entityRef: "chat_other", origins: [{ connectionId: "gmail_two", ...binding }] }));
    const results = await Promise.all(Array.from({ length: 5 }, () => store.requestPurge(owner, connection, "request_one")));
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    const status = await store.status(owner, results[0]!.id);
    expect(status?.pending).toBe(1);
    await expect(store.assertReadable(owner, "chat", "chat_one", [{ connectionId: connection, ...binding }])).rejects.toThrow();
    await expect(store.record(copy({ entityRef: "new_copy" }))).rejects.toThrow();
    await expect(store.assertReadable("outsider", "chat", "chat_one", [{ connectionId: connection, ...binding }])).resolves.toBeDefined();
    expect((await store.inspect(owner, "chat", "chat_other"))?.state).toBe("active");
    expect(await store.status("outsider", results[0]!.id)).toBeNull();
    await expect(store.requestPurge(owner, "gmail_two", "request_one")).rejects.toThrow();
  });
  it("concurrent queue claims never share a lease", async () => {
    for (let i = 0; i < 5; i++) await store.record(copy({ entityRef: `chat_${i}` }));
    await store.requestPurge(owner, connection, "request_one");
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => store.claimPurge(`worker_${i}`)));
    expect(claims.filter(Boolean)).toHaveLength(5);
    expect(new Set(claims.filter(Boolean).map(c => c!.jobId)).size).toBe(5);
  });
  it("deletes matching content once, settlement is idempotent and disconnect is unrelated", async () => {
    await store.record(copy());
    const request = await store.requestPurge(owner, connection, "request_one");
    const claim = (await store.claimPurge("worker"))!;
    let calls = 0;
    const handlers: PurgeHandlers = { chat: async input => { calls++; expect(input.expectedHash).toBe(digest); expect(input.ownerId).toBe(owner); return { status: "deleted" }; } };
    expect(await store.executeClaim(claim, handlers)).toBe("deleted");
    expect(await store.executeClaim(claim, handlers)).toBe("stale");
    expect(calls).toBe(1);
    expect(await store.status(owner, request.id)).toMatchObject({ deleted: 1, complete: true });
    expect((await store.inspect(owner, "chat", "chat_one"))?.state).toBe("deleted");
  });
  it.each(["modified", "unavailable"] as const)("keeps %s copies unresolved without claiming deletion", async outcome => {
    await store.record(copy());
    const request = await store.requestPurge(owner, connection, "request_one");
    await store.executeClaim((await store.claimPurge("worker"))!, { chat: async () => ({ status: outcome }) });
    expect(await store.status(owner, request.id)).toMatchObject({ unresolved: 1, deleted: 0, complete: false });
  });
  it("missing handlers fail closed; retry is bounded and content-free", async () => {
    store = createGoogleProvenanceStore(db, { maxAttempts: 2, retryDelayMs: 0 });
    await store.record(copy());
    const request = await store.requestPurge(owner, connection, "request_one");
    expect(await store.executeClaim((await store.claimPurge("worker"))!, {})).toBe("unresolved");
    expect(await store.status(owner, request.id)).toMatchObject({ unresolved: 1, complete: false });
    await store.record(copy({ entityRef: "chat_retry", origins: [{ connectionId: "retry_account", ...binding }] }));
    const retry = await store.requestPurge(owner, "retry_account", "request_retry");
    const handlers: PurgeHandlers = { chat: async () => { throw new Error("secret payload"); } };
    expect(await store.executeClaim((await store.claimPurge("worker"))!, handlers)).toBe("retry");
    expect(await store.executeClaim((await store.claimPurge("worker"))!, handlers)).toBe("unresolved");
    expect(await store.claimPurge("worker")).toBeNull();
    const state = await store.status(owner, retry.id);
    expect(JSON.stringify(state)).not.toContain("secret payload");
  });
  it("reclaims expired leases and refuses stale worker completion", async () => {
    await store.record(copy());
    await store.requestPurge(owner, connection, "request_one");
    const old = (await store.claimPurge("worker", { leaseMs: 10 }))!;
    await new Promise(resolve => setTimeout(resolve, 25));
    const next = (await store.claimPurge("worker_two"))!;
    expect(next.jobId).toBe(old.jobId);
    expect(next.revision).toBeGreaterThan(old.revision);
    expect(await store.executeClaim(old, { chat: async () => ({ status: "deleted" }) })).toBe("stale");
    expect(await store.executeClaim(next, { chat: async () => ({ status: "missing" }) })).toBe("deleted");
  });
  it("mixed origin purge removes the whole managed entity and associates all requesting accounts", async () => {
    await store.record(copy({ origins: [{ connectionId: connection, ...binding }, { connectionId: "gmail_two", ...binding }] }));
    const a = await store.requestPurge(owner, connection, "request_one");
    const b = await store.requestPurge(owner, "gmail_two", "request_two");
    await store.executeClaim((await store.claimPurge("worker"))!, { chat: async () => ({ status: "deleted" }) });
    expect(await store.status(owner, a.id)).toMatchObject({ deleted: 1, complete: true });
    expect(await store.status(owner, b.id)).toMatchObject({ deleted: 1, complete: true });
  });
  it("serializes per-owner caps, never silently evicts unresolved data", async () => {
    store = createGoogleProvenanceStore(db, { maxEntitiesPerOwner: 2 });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.record(copy({ entityRef: `entity_${i}` }))));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(2);
    store = createGoogleProvenanceStore(db, { maxJobs: 1 });
    await expect(store.requestPurge(owner, connection, "over_cap")).rejects.toThrow();
    expect((await store.inspect(owner, "chat", "entity_0"))?.state).toBe("active");
  });
  it("same-account requests reuse one durable receipt across different keys", async () => {
    await store.record(copy());
    const receipts = await Promise.all(Array.from({ length: 10 }, (_, i) => store.requestPurge(owner, connection, `request_${i}`)));
    expect(new Set(receipts.map(r => r.id)).size).toBe(1);
    await expect(store.requestPurge(owner, "another_account", "request_5")).rejects.toThrow();
  });
  it("a forged owner or revision cannot execute an existing lease", async () => {
    await store.record(copy());
    await store.requestPurge(owner, connection, "request");
    const claim = (await store.claimPurge("worker"))!;
    const handler = { chat: async () => ({ status: "deleted" as const }) };
    expect(await store.executeClaim({ ...claim, ownerId: "outsider" }, handler)).toBe("stale");
    expect(await store.executeClaim({ ...claim, revision: claim.revision + 1 }, handler)).toBe("stale");
    expect(await store.executeClaim(claim, handler)).toBe("deleted");
  });
  it("crashed lease retries eventually remain unresolved", async () => {
    store = createGoogleProvenanceStore(db, { maxAttempts: 1 });
    await store.record(copy());
    const receipt = await store.requestPurge(owner, connection, "request");
    await store.claimPurge("worker", { leaseMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await store.claimPurge("worker2")).toBeNull();
    expect(await store.status(owner, receipt.id)).toMatchObject({ unresolved: 1, complete: false });
  });
  it("restart with a tighter retry cap resolves exhausted pending work explicitly", async () => {
    store = createGoogleProvenanceStore(db, { maxAttempts: 2, retryDelayMs: 0 });
    await store.record(copy());
    const receipt = await store.requestPurge(owner, connection, "request");
    await store.executeClaim((await store.claimPurge("worker"))!, { chat: async () => { throw new Error("transient"); } });
    store = createGoogleProvenanceStore(db, { maxAttempts: 1 });
    expect(await store.claimPurge("worker")).toBeNull();
    expect(await store.status(owner, receipt.id)).toMatchObject({ unresolved: 1, pending: 0, complete: false });
  });
  it("handler timeouts remain unresolved even when the adapter ignores cancellation", async () => {
    store = createGoogleProvenanceStore(db, { handlerTimeoutMs: 5 });
    await store.record(copy());
    const receipt = await store.requestPurge(owner, connection, "request");
    expect(await store.executeClaim((await store.claimPurge("worker"))!, { chat: () => new Promise(() => {}) })).toBe("unresolved");
    expect(await store.status(owner, receipt.id)).toMatchObject({ unresolved: 1, deleted: 0, complete: false });
  });
  it("concurrent execution never invokes a handler twice", async () => {
    await store.record(copy());
    await store.requestPurge(owner, connection, "request");
    const claim = (await store.claimPurge("worker"))!;
    let calls = 0;
    const handler: PurgeHandlers = { chat: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { status: "deleted" }; } };
    const outcomes = await Promise.all([store.executeClaim(claim, handler), store.executeClaim(claim, handler)]);
    expect(outcomes.sort()).toEqual(["deleted", "stale"]);
    expect(calls).toBe(1);
  });
  it("prunes old completed metadata while retaining content-free receipts and tombstones", async () => {
    await store.record(copy());
    const receipt = await store.requestPurge(owner, connection, "request");
    await store.executeClaim((await store.claimPurge("worker"))!, { chat: async () => ({ status: "deleted" }) });
    expect(await store.cleanupDeleted()).toBe(0);
    await sql`UPDATE google_copy_registry SET updated_at=now()-interval '31 days'`.execute(db);
    expect(await store.cleanupDeleted()).toBe(1);
    expect(await store.inspect(owner, "chat", "chat_one")).toBeNull();
    expect(await store.status(owner, receipt.id)).toMatchObject({ deleted: 1, complete: true });
    await expect(store.record(copy({ entityRef: "new_copy" }))).rejects.toThrow();
  });
  it.each(["chat", "session", "import", "attachment", "derived"] as const)("dispatches %s only through its explicitly registered handler", async kind => {
    await store.record(copy({ kind }));
    const receipt = await store.requestPurge(owner, connection, "request");
    expect(await store.executeClaim((await store.claimPurge("worker"))!, { [kind]: async () => ({ status: "missing" as const }) })).toBe("deleted");
    expect(await store.status(owner, receipt.id)).toMatchObject({ deleted: 1, complete: true });
  });
  it("rejects revision changes, expired input, extra raw fields and malformed request IDs", async () => {
    await store.record(copy());
    await expect(store.assertReadable(owner, "chat", "chat_one", [{ connectionId: connection, ...binding, profileRevision: 2 }])).rejects.toThrow();
    await expect(store.record({ ...copy(), rawContent: "private" } as never)).rejects.toThrow();
    await expect(store.record(copy({ retention: { choice: "until", deadline: new Date(0).toISOString(), decisionId: "expired" } }))).rejects.toThrow();
    await expect(store.status(owner, "------------------------------------")).rejects.toThrow("Google data unavailable");
    await expect(store.claimPurge("worker", { leaseMs: 0 })).rejects.toThrow();
    await expect(store.queueExpired(1000)).rejects.toThrow();
    await expect(store.cleanupDeleted(0)).rejects.toThrow();
    expect(() => createGoogleProvenanceStore(db, { maxAttempts: 100 })).toThrow();
    await store.migrate();
    expect((await store.inspect(owner, "chat", "chat_one"))?.state).toBe("active");
  });
  it("rechecks retention after an awaited production advisory lock", async () => {
    const connection = await db.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035503)`.execute(held);
      try {
        const registration = store.record(copy({ entityRef: "expires_while_waiting", retention: { choice: "until", deadline: new Date(Date.now() + 80).toISOString(), decisionId: "short" } }));
        const outcome = registration.then(() => "written", () => "rejected");
        await new Promise(resolve => setTimeout(resolve, 130));
        await sql`SELECT pg_advisory_unlock(551035503)`.execute(held);
        return outcome;
      } finally { await sql`SELECT pg_advisory_unlock_all()`.execute(held); }
    });
    expect(connection).toBe("rejected");
    expect(await store.inspect(owner, "chat", "expires_while_waiting")).toBeNull();
  });
  it("sets production transaction timeouts before advisory lock admission", async () => {
    await db.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035503)`.execute(held);
      const started = Date.now();
      try {
        await expect(store.record(copy())).rejects.toThrow(/lock timeout/);
        expect(Date.now() - started).toBeLessThan(4000);
      } finally { await sql`SELECT pg_advisory_unlock(551035503)`.execute(held); }
    });
  });
  it("configures local production SQL budgets independently of the injected pool", async () => {
    const settings = await boundedProvenanceTransaction(db, async tx => (await sql<{ statement: string; lock: string }>`SELECT
      current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`.execute(tx)).rows[0]);
    expect(settings).toEqual({ statement: "5s", lock: "2s" });
  });
  it("rejects a retention deadline that expires while waiting for the entity row lock", async () => {
    const initial = await store.record(copy());
    let completion: Promise<string> | undefined;
    await db.transaction().execute(async held => {
      await sql`SELECT id FROM google_copy_registry WHERE owner_id=${owner} FOR UPDATE`.execute(held);
      const pending = store.record(copy({ baseRevision: initial.revision, contentHash: "b".repeat(64), retention: { choice: "until", deadline: new Date(Date.now() + 100).toISOString(), decisionId: "short" } }));
      const result = pending.then(() => "written", () => "rejected");
      await new Promise(resolve => setTimeout(resolve, 140));
      // End the lock holder before awaiting registration; the outer variable receives the pending result.
      completion = result;
    });
    expect(await completion).toBe("rejected");
    expect((await store.inspect(owner, "chat", "chat_one"))?.contentHash).toBe(digest);
  });
  it("owner metadata finalization requires trusted full-duration account-deletion admission", async () => {
    await expect(store.finalizeOwnerDeletion(owner)).rejects.toThrow("Google data unavailable");
    const declining = createGoogleProvenanceStore(db, {}, { withOwnerDeletionAdmission: async () => null });
    await expect(declining.finalizeOwnerDeletion(owner)).rejects.toThrow("Google data unavailable");
    let guarded = false;
    const admitted = createGoogleProvenanceStore(db, {}, { withOwnerDeletionAdmission: async (_owner, work) => {
      expect(_owner).toBe(owner); guarded = true;
      try { return await work(); } finally { guarded = false; }
    } });
    await admitted.record(copy());
    await admitted.record(copy({ ownerId: "outsider" }));
    await expect(admitted.finalizeOwnerDeletion(owner)).rejects.toThrow();
    const receipt = await admitted.requestPurge(owner, connection, "request");
    await expect(admitted.finalizeOwnerDeletion(owner)).rejects.toThrow();
    const claim = (await admitted.claimPurge("worker"))!;
    await expect(admitted.finalizeOwnerDeletion(owner)).rejects.toThrow();
    await admitted.executeClaim(claim, { chat: async () => ({ status: "deleted" }) });
    await sql`UPDATE google_copy_purge_jobs SET lease_token=${randomUUID()},lease_until=now()-interval '1 minute' WHERE owner_id=${owner}`.execute(db);
    await expect(admitted.finalizeOwnerDeletion(owner)).rejects.toThrow();
    await sql`UPDATE google_copy_purge_jobs SET lease_token=NULL,lease_until=NULL WHERE owner_id=${owner}`.execute(db);
    expect(await admitted.finalizeOwnerDeletion(owner)).toEqual({ finalized: true, coverage: "registered-copies-only" });
    expect(guarded).toBe(false);
    expect(await admitted.inspect(owner, "chat", "chat_one")).toBeNull();
    expect(await admitted.status(owner, receipt.id)).toBeNull();
    expect((await admitted.inspect("outsider", "chat", "chat_one"))?.state).toBe("active");
    for (const table of ["google_copy_registry", "google_copy_purge_requests", "google_copy_purge_jobs", "google_copy_purge_keys"]) {
      expect((await sql`SELECT 1 FROM ${sql.id(table)} WHERE owner_id=${owner}`.execute(db)).rows).toHaveLength(0);
    }
    expect((await sql`SELECT 1 FROM google_copy_purge_links`.execute(db)).rows).toHaveLength(0);
  });
  it("owner finalization refuses unresolved and expired-but-unsettled leases", async () => {
    const admitted = createGoogleProvenanceStore(db, {}, { withOwnerDeletionAdmission: async (_owner, work) => work() });
    await admitted.record(copy());
    await admitted.requestPurge(owner, connection, "request");
    await admitted.claimPurge("worker", { leaseMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    await expect(admitted.finalizeOwnerDeletion(owner)).rejects.toThrow();
    await admitted.executeClaim((await admitted.claimPurge("next"))!, {});
    await expect(admitted.finalizeOwnerDeletion(owner)).rejects.toThrow();
    expect((await admitted.inspect(owner, "chat", "chat_one"))?.state).toBe("purging");
  });
  it("expired retention queues cleanup and blocks reads", async () => {
    await store.record(copy({ retention: { choice: "until", deadline: new Date(Date.now() + 100).toISOString(), decisionId: "short" } }));
    await new Promise(resolve => setTimeout(resolve, 120));
    await expect(store.assertReadable(owner, "chat", "chat_one", [{ connectionId: connection, ...binding }])).rejects.toThrow();
    await store.queueExpired();
    expect(await store.executeClaim((await store.claimPurge("worker"))!, { chat: async () => ({ status: "deleted" }) })).toBe("deleted");
  });
});
