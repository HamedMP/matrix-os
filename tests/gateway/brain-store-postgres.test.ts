import { randomUUID } from "node:crypto";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrainRepository,
  BrainStoreError,
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

  beforeEach(async () => {
    schema = `brain_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const clock = new Date("2026-10-01T10:00:00.000Z");
    const dialect = (): PostgresDialect =>
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
});
