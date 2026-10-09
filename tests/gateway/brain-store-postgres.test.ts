import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql, type KyselyPlugin } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrainRepository,
  BrainStoreError,
  type BrainDatabase,
  type BrainSyncBatchInput,
  type BrainSyncBatchResult,
} from "../../packages/gateway/src/brain/index.js";
import { brainContent, brainDocumentId, scopeA } from "./helpers/brain-store-helpers.js";

// PGlite is single-connection, so the per-scope advisory lock and the cursor CAS
// are only proven here. Only a disposable test server is appropriate: every test
// creates its own schema and drops it afterwards.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const natural = { kind: "slack", externalRef: "T/C", label: "Slack" };

function settle(results: readonly PromiseSettledResult<BrainSyncBatchResult>[]): {
  readonly won: readonly BrainSyncBatchResult[];
  readonly lost: readonly unknown[];
} {
  return {
    won: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    lost: results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  };
}

function expectConflict(reason: unknown): void {
  expect(reason).toBeInstanceOf(BrainStoreError);
  expect((reason as BrainStoreError).code).toBe("conflict");
}

describe.skipIf(!databaseUrl)("brain store across independent PostgreSQL connections", () => {
  let admin: pg.Pool;
  let schema: string;
  let first: BrainRepository;
  let second: BrainRepository;
  let dialect: () => PostgresDialect;

  beforeEach(async () => {
    schema = `brain_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const clock = new Date("2026-10-01T10:00:00.000Z");
    dialect = (): PostgresDialect =>
      new PostgresDialect({ pool: new pg.Pool({ connectionString: url.toString(), max: 2 }) });
    first = new BrainRepository(dialect(), { now: () => clock });
    second = new BrainRepository(dialect(), { now: () => clock });
    await Promise.all([first.bootstrap(), second.bootstrap()]);
  });

  afterEach(async () => {
    await first?.destroy();
    await second?.destroy();
    if (schema && admin) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it("bootstraps concurrently and creates one source for one natural key", async () => {
    const tables = await admin.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "brain_claims", "brain_document_refs", "brain_document_revisions", "brain_documents", "brain_extraction_runs",
      "brain_extraction_state", "brain_sources", "brain_sync_cursors", "brain_sync_receipts",
    ]);
    const created = await Promise.all([first.createSource(scopeA, natural), second.createSource(scopeA, natural)]);
    expect(created.map((result) => result.created).sort()).toEqual([false, true]);
    expect(created[0].source.sourceId).toBe(created[1].source.sourceId);
    expect((await first.listSources(scopeA)).items).toHaveLength(1);
  });

  it("lets exactly one of two concurrent first batches create the cursor", async () => {
    const { source } = await first.createSource(scopeA, natural);
    const seed: BrainSyncBatchInput = {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", upserts: [brainContent("one")], deletions: [],
    };
    const { won, lost } = settle(await Promise.allSettled([
      first.applySyncBatch(scopeA, seed),
      second.applySyncBatch(scopeA, { ...seed, nextCursor: "other", upserts: [brainContent("two")] }),
    ]));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expectConflict(lost[0]);
    const cursor = await second.getSyncCursor(scopeA, source.sourceId);
    expect(cursor?.cursor).toBe(won[0]!.cursor.cursor);
    const winner = cursor?.cursor === "c1" ? "one" : "two";
    const loser = winner === "one" ? "two" : "one";
    expect(await first.getDocument(scopeA, brainDocumentId(winner))).not.toBeNull();
    expect(await first.getDocument(scopeA, brainDocumentId(loser))).toBeNull();
  });

  it("serializes concurrent cursor advances so the second finds the cursor moved and writes nothing", async () => {
    const { source } = await first.createSource(scopeA, natural);
    const seed: BrainSyncBatchInput = {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", upserts: [brainContent("one")], deletions: [],
    };
    await first.applySyncBatch(scopeA, seed);
    const { won, lost } = settle(await Promise.allSettled([
      first.applySyncBatch(scopeA, { ...seed, expectedCursor: "c1", nextCursor: "c2", upserts: [brainContent("two")] }),
      second.applySyncBatch(scopeA, { ...seed, expectedCursor: "c1", nextCursor: "c3", upserts: [brainContent("three")] }),
    ]));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expectConflict(lost[0]);
    expect(won[0]).toMatchObject({ created: 1, updated: 0, unchanged: 0, deleted: 0, rejected: [] });
    const cursor = await second.getSyncCursor(scopeA, source.sourceId);
    expect(cursor?.cursor).toBe(won[0]!.cursor.cursor);
    const loser = cursor?.cursor === "c2" ? "three" : "two";
    expect(await first.getDocument(scopeA, brainDocumentId(loser))).toBeNull();
    expect((await first.listDocuments(scopeA)).items).toHaveLength(2);
    // The loser's retry against the advanced cursor applies cleanly.
    const retry = await second.applySyncBatch(scopeA, {
      ...seed, expectedCursor: cursor!.cursor, nextCursor: "c4", upserts: [brainContent(loser)],
    });
    expect(retry.created).toBe(1);
    expect((await first.listDocuments(scopeA)).items).toHaveLength(3);
  });

  it("reads a ref page, its total and its refs from one snapshot while a sync batch commits", async () => {
    const { source } = await first.createSource(scopeA, natural);
    const document = brainContent("why", { body: "old body" });
    const path = { kind: "path", value: "src/a.ts" };
    await first.applySyncBatch(scopeA, {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1",
      upserts: [{ ...document, refs: [path, { kind: "spec", value: "old-spec" }] }], deletions: [],
    });
    let batch: Promise<BrainSyncBatchResult> | null = null;
    // Once the page has read the old body, a sync batch on another connection commits a new body, new refs and a
    // second matching document before the reader's next statement runs.
    const commitBetweenStatements: KyselyPlugin = {
      transformQuery: (args) => args.node,
      async transformResult(args) {
        if (batch === null && args.result.rows.some((row) => "cursor_at" in row)) {
          batch = second.applySyncBatch(scopeA, {
            sourceId: source.sourceId, expectedCursor: "c1", nextCursor: "c2", deletions: [],
            upserts: [
              { ...document, body: "new body", refs: [path, { kind: "spec", value: "new-spec" }] },
              { ...brainContent("later"), refs: [path] },
            ],
          });
          await batch;
        }
        return args.result;
      },
    };
    const readerDb = new Kysely<BrainDatabase>({ dialect: dialect(), plugins: [commitBetweenStatements] });
    const query = {
      kind: "path", value: "src/a.ts", mode: "exact_or_under", provenances: ["manual"], extraRefKinds: ["spec"],
    } as const;
    try {
      const page = await new BrainRepository(readerDb).listDocumentsByRef(scopeA, query);
      expect(await batch).toMatchObject({ created: 1, updated: 1 });
      expect(page.items.map((item) => [item.document.body, item.document.revision, item.refs])).toEqual([
        ["old body", 1, [path, { kind: "spec", value: "old-spec" }]],
      ]);
      expect([page.total, page.totalCapped, page.nextCursor]).toEqual([1, false, null]);
      const after = await first.listDocumentsByRef(scopeA, query);
      expect(after.total).toBe(2);
      expect(after.items.find((item) => item.document.documentId === document.documentId)?.refs)
        .toEqual([path, { kind: "spec", value: "new-spec" }]);
    } finally {
      await readerDb.destroy();
    }
  });

  it("commits a source update with the write made alongside it, so no connection sees one without the other", async () => {
    const { source } = await first.createSource(scopeA, natural);
    await admin.query(`CREATE TABLE "${schema}".side_config (source_id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const written = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const update = first.updateSource(scopeA, { sourceId: source.sourceId, expectedRevision: 1, label: "Renamed" }, async (trx) => {
      await sql`INSERT INTO side_config VALUES (${source.sourceId}, 'new')`.execute(trx);
      written.resolve();
      await held.promise;
    });
    await written.promise;
    // Until the update commits, another connection sees neither the new revision nor the write made alongside it.
    expect((await second.getSource(scopeA, source.sourceId))?.revision).toBe(1);
    expect((await admin.query(`SELECT count(*)::int AS n FROM "${schema}".side_config`)).rows).toEqual([{ n: 0 }]);
    const stale = second.updateSource(scopeA, { sourceId: source.sourceId, expectedRevision: 1, label: "Stale" });
    held.resolve();
    expect(await update).toMatchObject({ revision: 2, label: "Renamed" });
    await expect(stale).rejects.toMatchObject({ code: "conflict" });
    expect((await admin.query(`SELECT value FROM "${schema}".side_config`)).rows).toEqual([{ value: "new" }]);
    // A write alongside that fails takes the revision back with it.
    await expect(first.updateSource(scopeA, { sourceId: source.sourceId, expectedRevision: 2, label: "Lost" }, async () => {
      throw new Error("config refused");
    })).rejects.toThrow("config refused");
    expect(await second.getSource(scopeA, source.sourceId)).toMatchObject({ revision: 2, label: "Renamed" });
  });

  it("creates a source with the write made alongside it, so another gateway never finds one without the other", async () => {
    await admin.query(`CREATE TABLE "${schema}".side_config (source_id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const [written, held] = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const create = first.createSource(scopeA, natural, async (trx, next) => {
      await sql`INSERT INTO side_config VALUES (${next.sourceId}, 'first')`.execute(trx);
      written.resolve();
      await held.promise;
    });
    await written.promise;
    expect((await second.listSources(scopeA)).items).toEqual([]);
    // The other gateway's create of the same identity waits for this one, then finds it with its write.
    const again = second.createSource(scopeA, natural, async () => { throw new Error("not a new source"); });
    held.resolve();
    expect([(await create).created, (await again).created]).toEqual([true, false]);
    expect((await admin.query(`SELECT value FROM "${schema}".side_config`)).rows).toEqual([{ value: "first" }]);
    // A write alongside that fails leaves no source.
    const refused = async () => { throw new Error("config refused"); };
    await expect(first.createSource(scopeA, { ...natural, externalRef: "T/D" }, refused)).rejects.toThrow("config refused");
    expect((await second.listSources(scopeA)).items).toHaveLength(1);
  });

  it("commits a source's replacement with the write made alongside it, so no connection sees one without the other", async () => {
    const { source } = await first.createSource(scopeA, natural);
    await admin.query(`CREATE TABLE "${schema}".side_config (source_id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const written = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const live = async () => (await second.listSources(scopeA)).items.map((item) => item.sourceId);
    const replace = first.replaceSource(scopeA, { sourceId: source.sourceId, expectedRevision: 1, label: "Again" }, async (trx, next) => {
      await sql`INSERT INTO side_config VALUES (${next.sourceId}, 'new')`.execute(trx);
      written.resolve();
      await held.promise;
    });
    await written.promise;
    // Until the replacement commits, another connection sees the old source and neither its successor nor the write.
    expect(await live()).toEqual([source.sourceId]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM "${schema}".side_config`)).rows).toEqual([{ n: 0 }]);
    held.resolve();
    const { removed, source: next } = await replace;
    expect(removed).toMatchObject({ sourceId: source.sourceId, revision: 2, deletedAt: expect.any(String) });
    expect(next).toMatchObject({ kind: natural.kind, externalRef: natural.externalRef, label: "Again", revision: 1 });
    expect(await live()).toEqual([next.sourceId]);
    expect((await admin.query(`SELECT source_id FROM "${schema}".side_config`)).rows).toEqual([{ source_id: next.sourceId }]);
    // A write alongside that fails takes the removal back with it.
    await expect(first.replaceSource(scopeA, { sourceId: next.sourceId, expectedRevision: 1, label: "Lost" }, async () => {
      throw new Error("config refused");
    })).rejects.toThrow("config refused");
    expect(await second.getSource(scopeA, next.sourceId)).toMatchObject({ revision: 1, label: "Again" });
    expect(await live()).toEqual([next.sourceId]);
  });
});
