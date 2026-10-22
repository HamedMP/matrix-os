import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { createGoogleContextStore, type GoogleContextMark } from "../../../../packages/gateway/src/google-data/runtime/contexts.js";

const suite = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const owner = "owner_one";
const account = "10000000-0000-4000-8000-000000000001";
const otherAccount = "10000000-0000-4000-8000-000000000002";
const future = (ms = 86_400_000) => new Date(Date.now() + ms).toISOString();
const mark = (extra: Partial<GoogleContextMark> = {}): GoogleContextMark => ({ ownerId: owner, chatId: "chat_one",
  googleAccountId: account, consentId: "consent_one", profileId: "managed", profileRevision: 1,
  purposeId: "assistant", expiresAt: future(), retentionDeadline: future(), ...extra });

suite("durable conservative Google context classification", () => {
  let db: Kysely<Record<string, never>>;
  let admin: Kysely<Record<string, never>>;
  let schema: string;
  let store: ReturnType<typeof createGoogleContextStore>;
  beforeEach(async () => {
    const connectionString = process.env.MATRIX_TEST_POSTGRES_URL!;
    if (!new URL(connectionString).pathname.includes("test")) throw new Error("Dedicated test database required");
    schema = `contexts_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 10, options: `-c search_path=${schema}` }) }) });
    store = createGoogleContextStore(db);
    await store.migrate();
  });
  afterEach(async () => {
    if (db) await db.destroy();
    if (admin) { await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); }
  });
  it("persists a marker and deterministic private source mapping before collection", async () => {
    expect(await store.inspect(owner, "chat_one")).toBeNull();
    const stamped = mark();
    const context = await store.mark(stamped);
    expect(context.sources[0]?.originId).toBe(createHash("sha256").update(JSON.stringify([owner, account, "consent_one"])).digest("hex"));
    const reopened = createGoogleContextStore(db);
    expect(await reopened.inspect(owner, "chat_one")).toEqual(context);
    expect(await reopened.inspect("outsider", "chat_one")).toBeNull();
    expect(await reopened.sourcesForAccount(owner, account)).toHaveLength(1);
    expect(await reopened.sourcesForAccount("outsider", account)).toEqual([]);
  });
  it("keeps expired markers classified and blocks inheritance", async () => {
    let now = new Date();
    store = createGoogleContextStore(db, { now: () => now });
    await store.mark(mark({ expiresAt: future(1000) }));
    now = new Date(Date.now() + 2000);
    expect(await store.inspect(owner, "chat_one")).toMatchObject({ availability: "expired" });
    await expect(store.inherit(owner, "target", ["chat_one"])).rejects.toThrow("Google context unavailable");
    expect(await store.inspect(owner, "chat_one")).not.toBeNull();
  });
  it("unions mixed source generations and preserves the earliest retention deadline", async () => {
    const deadline = future(10000);
    const a = await store.mark(mark({ retentionDeadline: deadline }));
    const b = await store.mark(mark({ chatId: "chat_two", googleAccountId: otherAccount, consentId: "consent_two", profileId: "byo" }));
    const inherited = await store.inherit(owner, "target", ["chat_one", "chat_two"]);
    expect(inherited.sources).toHaveLength(2);
    expect(inherited.retentionDeadline).toBe(deadline);
    expect(inherited.sources.map(s => s.originId).sort()).toEqual([a.sources[0]!.originId, b.sources[0]!.originId].sort());
    await expect(store.inherit(owner, "target", ["chat_two"])).rejects.toThrow();
    const updated = await store.inherit(owner, "target", ["chat_two"], inherited.revision);
    expect(updated.sources).toHaveLength(2);
    expect(updated.retentionDeadline).toBe(deadline);
  });
  it("does not inherit absent or other-owner sources into a new unclassified target", async () => {
    await store.mark(mark({ ownerId: "outsider" }));
    await expect(store.inherit(owner, "target", ["chat_one"])).rejects.toThrow();
    expect(await store.inspect(owner, "target")).toBeNull();
    await expect(store.inherit(owner, "target", [])).rejects.toThrow();
  });
  it("concurrent source appends require an exact context revision", async () => {
    const first = await store.mark(mark());
    const results = await Promise.allSettled([
      store.mark(mark({ consentId: "consent_two", expectedRevision: first.revision })),
      store.mark(mark({ consentId: "consent_three", expectedRevision: first.revision })),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.inspect(owner, "chat_one"))?.sources).toHaveLength(2);
  });
  it("retains every account generation on purge and prevents old-consent regrowth", async () => {
    await store.mark(mark());
    await store.mark(mark({ chatId: "chat_two", consentId: "consent_two" }));
    await store.mark(mark({ chatId: "unrelated", googleAccountId: otherAccount }));
    await store.mark(mark({ ownerId: "outsider" }));
    const purged = await store.beginPurge(owner, account);
    expect(purged.originIds).toHaveLength(2);
    expect(purged.chatIds.sort()).toEqual(["chat_one", "chat_two"]);
    expect((await store.inspect(owner, "chat_one"))?.availability).toBe("purging");
    await expect(store.mark(mark({ chatId: "regrow" }))).rejects.toThrow();
    await expect(store.inherit(owner, "target", ["chat_one"])).rejects.toThrow();
    const fresh = await store.mark(mark({ chatId: "fresh_chat", consentId: "fresh_consent" }));
    expect(fresh.availability).toBe("available");
    expect((await store.sourcesForAccount(owner, account))).toHaveLength(3);
    expect((await store.inspect(owner, "unrelated"))?.availability).toBe("available");
    expect((await store.inspect("outsider", "chat_one"))?.availability).toBe("available");
    expect((await store.inspect(owner, "chat_one"))?.availability).toBe("purging");
  });
  it("a mixed context stays closed even when only one source account is purged", async () => {
    const first = await store.mark(mark());
    await store.mark(mark({ googleAccountId: otherAccount, expectedRevision: first.revision }));
    await store.beginPurge(owner, account);
    expect((await store.inspect(owner, "chat_one"))?.sources).toHaveLength(2);
    expect((await store.inspect(owner, "chat_one"))?.availability).toBe("purging");
    await expect(store.mark(mark({ consentId: "new", expectedRevision: 3 }))).rejects.toThrow();
  });
  it("cannot redefine a known consent's profile, purpose or revision", async () => {
    await store.mark(mark());
    for (const extra of [{ profileId: "forged" }, { profileRevision: 2 }, { purposeId: "marketing" }]) {
      await expect(store.mark(mark({ chatId: "other", ...extra }))).rejects.toThrow();
    }
    expect(await store.inspect(owner, "other")).toBeNull();
  });
  it("caps metadata atomically without dropping classification", async () => {
    store = createGoogleContextStore(db, { limits: { maxContextsPerOwner: 2 } });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.mark(mark({ chatId: `chat_${i}` }))));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect((await sql`SELECT * FROM google_context_markers WHERE owner_id=${owner}`.execute(db)).rows).toHaveLength(2);
  });
  it("caps source mappings and mixed lineage atomically without orphan classification", async () => {
    store = createGoogleContextStore(db, { limits: { maxSourcesPerOwner: 2, maxSourcesPerContext: 2 } });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.mark(mark({ chatId: `source_${i}`, consentId: `consent_${i}` }))));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(await store.sourcesForAccount(owner, account)).toHaveLength(2);
    expect((await sql`SELECT * FROM google_context_markers WHERE owner_id=${owner}`.execute(db)).rows).toHaveLength(2);
    const full = createGoogleContextStore(db, { limits: { maxSourcesPerContext: 2 } });
    const first = await full.mark(mark({ chatId: "mixed", consentId: "mixed_1" }));
    const next = await full.mark(mark({ chatId: "mixed", consentId: "mixed_2", expectedRevision: first.revision }));
    await expect(full.mark(mark({ chatId: "mixed", consentId: "mixed_3", expectedRevision: next.revision }))).rejects.toThrow();
    expect((await full.inspect(owner, "mixed"))?.sources).toHaveLength(2);
    expect((await full.sourcesForAccount(owner, account)).some(s => s.consentId === "mixed_3")).toBe(false);
  });
  it("same-consent re-marking cannot extend source approval expiry", async () => {
    const first = await store.mark(mark({ expiresAt: future(1000) }));
    const next = await store.mark(mark({ chatId: "other", expiresAt: future(100000) }));
    expect(next.sources[0]!.expiresAt).toBe(first.sources[0]!.expiresAt);
  });
  it("repeated account purges are idempotent and stale-consent races cannot regrow available contexts", async () => {
    await store.mark(mark());
    await Promise.allSettled([store.mark(mark({ chatId: "racing" })), store.beginPurge(owner, account)]);
    const racing = await store.inspect(owner, "racing");
    expect(racing === null || racing.availability === "purging").toBe(true);
    const first = await store.beginPurge(owner, account);
    const repeated = await store.beginPurge(owner, account);
    expect(repeated.revisions).toEqual(first.revisions);
    expect(new Set(repeated.originIds)).toEqual(new Set(first.originIds));
  });
  it("rejects expired, malformed, content-bearing and unbounded input", async () => {
    await expect(store.mark(mark({ expiresAt: new Date(0).toISOString() }))).rejects.toThrow();
    await expect(store.mark(mark({ retentionDeadline: future(31 * 86_400_000) }))).rejects.toThrow();
    await expect(store.mark(mark({ googleAccountId: "../../secret" }))).rejects.toThrow();
    await expect(store.mark({ ...mark(), rawContent: "private" } as never)).rejects.toThrow();
    await expect(store.inherit(owner, "target", Array.from({ length: 33 }, (_, i) => `chat_${i}`))).rejects.toThrow();
  });
  it("revalidates expiry after waiting for the classification lock", async () => {
    await db.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      try {
        const result = store.mark(mark({ expiresAt: future(60) })).then(() => "written", () => "rejected");
        await new Promise(resolve => setTimeout(resolve, 100));
        await sql`SELECT pg_advisory_unlock(551035504)`.execute(held);
        expect(await result).toBe("rejected");
      } finally { await sql`SELECT pg_advisory_unlock_all()`.execute(held); }
    });
    expect(await store.inspect(owner, "chat_one")).toBeNull();
  });
  it("serializes source append against account purge without losing either lineage or the closed marker", async () => {
    const first = await store.mark(mark());
    await Promise.allSettled([store.mark(mark({ googleAccountId: otherAccount, expectedRevision: first.revision })), store.beginPurge(owner, account)]);
    const current = (await store.inspect(owner, "chat_one"))!;
    expect(current.availability).toBe("purging");
    expect(current.sources.some(s => s.googleAccountId === account)).toBe(true);
  });
  it("owner metadata finalization requires quiesced owner admission and all content markers deleted", async () => {
    await expect(store.finalizeOwnerDeletion(owner)).rejects.toThrow();
    let liveWrites = true;
    const guarded = createGoogleContextStore(db, {
      deletionAuthority: { withVerifiedContextDeletion: async (_owner, _chat, work) => work() },
      ownerDeletionAuthority: { withOwnerDeletionAdmission: async (_owner, work) => liveWrites ? null : work() },
    });
    await guarded.mark(mark());
    await guarded.mark(mark({ ownerId: "outsider" }));
    await expect(guarded.finalizeOwnerDeletion(owner)).rejects.toThrow();
    liveWrites = false;
    await expect(guarded.finalizeOwnerDeletion(owner)).rejects.toThrow();
    const purged = await guarded.beginPurge(owner, account);
    await expect(guarded.finalizeOwnerDeletion(owner)).rejects.toThrow();
    await guarded.completeDeletion(owner, "chat_one", purged.revisions["chat_one"]!);
    liveWrites = true;
    await expect(guarded.finalizeOwnerDeletion(owner)).rejects.toThrow();
    expect(await guarded.sourcesForAccount(owner, account)).toHaveLength(1);
    liveWrites = false;
    expect(await guarded.finalizeOwnerDeletion(owner)).toEqual({ finalized: true, coverage: "registered-contexts-only" });
    expect(await guarded.inspect(owner, "chat_one")).toBeNull();
    expect(await guarded.sourcesForAccount(owner, account)).toEqual([]);
    expect((await guarded.inspect("outsider", "chat_one"))?.availability).toBe("available");
    for (const table of ["google_context_markers", "google_context_sources"]) {
      expect((await sql`SELECT 1 FROM ${sql.id(table)} WHERE owner_id=${owner}`.execute(db)).rows).toHaveLength(0);
    }
  });
  it("owner finalization fails closed while a mutation lock is held", async () => {
    const guarded = createGoogleContextStore(db, { ownerDeletionAuthority: { withOwnerDeletionAdmission: async (_owner, work) => work() } });
    await db.connection().execute(async held => {
      await sql`SELECT pg_advisory_lock(551035504)`.execute(held);
      try { await expect(guarded.finalizeOwnerDeletion(owner)).rejects.toThrow(/lock timeout/); }
      finally { await sql`SELECT pg_advisory_unlock(551035504)`.execute(held); }
    });
  });
  it("cleanup requires verified-content deletion admission and preserves a permanently closed marker", async () => {
    await store.mark(mark());
    const purged = await store.beginPurge(owner, account);
    await expect(store.completeDeletion(owner, "chat_one", purged.revisions["chat_one"]!)).rejects.toThrow();
    const declined = createGoogleContextStore(db, { deletionAuthority: { withVerifiedContextDeletion: async () => null } });
    await expect(declined.completeDeletion(owner, "chat_one", purged.revisions["chat_one"]!)).rejects.toThrow();
    expect((await declined.inspect(owner, "chat_one"))?.availability).toBe("purging");
    const guarded = createGoogleContextStore(db, { deletionAuthority: { withVerifiedContextDeletion: async (_owner, _chat, work) => work() } });
    await expect(guarded.completeDeletion(owner, "chat_one", 999)).rejects.toThrow();
    await guarded.completeDeletion(owner, "chat_one", purged.revisions["chat_one"]!);
    expect(await guarded.inspect(owner, "chat_one")).toMatchObject({ availability: "deleted", sources: [] });
    await expect(guarded.mark(mark({ consentId: "fresh", expectedRevision: 3 }))).rejects.toThrow();
    await expect(guarded.inherit(owner, "target", ["chat_one"])).rejects.toThrow();
    expect(await guarded.sourcesForAccount(owner, account)).toHaveLength(1);
  });
});
