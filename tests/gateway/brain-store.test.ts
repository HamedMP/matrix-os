import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeBrainContentHash, type BrainEvidenceProof } from "../../packages/gateway/src/brain/index.js";
import {
  BRAIN_CLOCK_START,
  BRAIN_CLAIM_TABLES,
  BRAIN_TABLES,
  brainContent,
  brainDocumentId,
  countBrainRows,
  createBrainHarness,
  expectBrainError,
  manualDocument,
  scopeA,
  scopeB,
  scopeOtherOwner,
  seedBrainScope,
  type BrainHarness,
} from "./helpers/brain-store-helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAMED_INDEXES = [
  "brain_sources_live_ref", "brain_documents_search", "brain_documents_source", "brain_sync_receipts_started",
  "brain_document_refs_lookup", "brain_documents_recent", "brain_claims_document", "brain_extraction_runs_running",
  "brain_extraction_runs_started",
];

describe("brain store", () => {
  let harness: BrainHarness;

  beforeEach(async () => {
    harness = await createBrainHarness();
  });

  afterEach(() => harness.destroy());

  it("bootstraps idempotently with the exact table and index inventory", async () => {
    await harness.repository.bootstrap();
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'brain\\_%' ORDER BY table_name
    `.execute(harness.db);
    expect(tables.rows.map((row) => row.table_name)).toEqual([...BRAIN_TABLES, ...BRAIN_CLAIM_TABLES].sort());
    const indexes = await sql<{ indexname: string; indexdef: string }>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename LIKE 'brain\\_%'
    `.execute(harness.db);
    const names = indexes.rows.map((row) => row.indexname);
    for (const name of NAMED_INDEXES) expect(names).toContain(name);
    expect(names.filter((name) => name.endsWith("_pkey"))).toHaveLength(BRAIN_TABLES.length + BRAIN_CLAIM_TABLES.length);
    const search = indexes.rows.find((row) => row.indexname === "brain_documents_search");
    expect(search?.indexdef).toMatch(/gin.*to_tsvector\('simple'/i);
    expect(search?.indexdef).toContain("WHERE (deleted_at IS NULL)");
  });

  it("isolates every table by owner and scope", async () => {
    const { repository, db } = harness;
    const sourceA = await seedBrainScope(harness, scopeA);
    const sourceB = await seedBrainScope(harness, scopeB);
    const sourceOther = await seedBrainScope(harness, scopeOtherOwner);
    const documentId = brainDocumentId("seed");
    for (const table of BRAIN_TABLES) {
      expect(await countBrainRows(db, table, scopeA)).toBe(1);
      expect(await countBrainRows(db, table, scopeB)).toBe(1);
      expect(await countBrainRows(db, table, scopeOtherOwner)).toBe(1);
    }
    expect((await repository.listSources(scopeA)).items.map((source) => source.sourceId)).toEqual([sourceA]);
    expect((await repository.listSources(scopeB)).items.map((source) => source.sourceId)).toEqual([sourceB]);
    expect((await repository.listSources(scopeOtherOwner)).items.map((s) => s.sourceId)).toEqual([sourceOther]);
    expect(await repository.getSource(scopeB, sourceA)).toBeNull();
    expect(await repository.getSource(scopeOtherOwner, sourceA)).toBeNull();

    const documentA = await repository.getDocument(scopeA, documentId);
    const documentOther = await repository.getDocument(scopeOtherOwner, documentId);
    expect(documentA).toMatchObject({ ownerId: "owner_a", scopeId: "scope_a", sourceId: sourceA });
    expect(documentOther).toMatchObject({ ownerId: "owner_b", scopeId: "scope_a", sourceId: sourceOther });
    expect(documentA?.incarnation).not.toBe(documentOther?.incarnation);
    expect(await repository.getDocument({ ownerId: "owner_c", scopeId: "scope_a" }, documentId)).toBeNull();
    expect((await repository.listDocuments(scopeB)).items.map((d) => d.sourceId)).toEqual([sourceB]);
    expect((await repository.searchDocuments(scopeA, { query: "seed" })).map((d) => d.ownerId)).toEqual(["owner_a"]);
    expect((await repository.listRevisions(scopeOtherOwner, documentId)).map((r) => r.scopeId)).toEqual(["scope_a"]);
    expect(await repository.listRevisions({ ownerId: "owner_c", scopeId: "scope_a" }, documentId)).toEqual([]);

    expect(await repository.getSyncCursor(scopeA, sourceB)).toBeNull();
    expect(await repository.getSyncCursor(scopeOtherOwner, sourceA)).toBeNull();
    expect((await repository.getSyncCursor(scopeA, sourceA))?.cursor).toBe("c2");
    expect(await repository.listSyncReceipts(scopeA, sourceB)).toEqual([]);
    expect(await repository.listSyncReceipts(scopeA, sourceA)).toHaveLength(1);

    await expectBrainError(repository.updateSource(scopeB, { sourceId: sourceA, expectedRevision: 1, label: "x" }), "not_found");
    await expectBrainError(
      repository.updateSource(scopeOtherOwner, { sourceId: sourceA, expectedRevision: 1, label: "x" }), "not_found",
    );
    await expectBrainError(repository.deleteDocument(scopeB, { documentId: brainDocumentId("nope") }), "not_found");
    await expectBrainError(repository.getDocument({ ownerId: "", scopeId: "scope_a" }, documentId), "invalid");
  });

  it("creates sources idempotently and updates them with CAS", async () => {
    const { repository } = harness;
    const first = await repository.createSource(scopeA, { kind: "slack", externalRef: "T1/C1", label: "Eng" });
    expect(first.created).toBe(true);
    expect(first.source).toMatchObject({
      scopeId: "scope_a", ownerId: "owner_a", kind: "slack", externalRef: "T1/C1", label: "Eng", status: "active",
      revision: 1, createdAt: BRAIN_CLOCK_START, updatedAt: BRAIN_CLOCK_START, deletedAt: null,
    });
    expect(first.source.sourceId).toMatch(/^src_[a-f0-9]{32}$/);
    const again = await repository.createSource(scopeA, { kind: "slack", externalRef: "T1/C1", label: "Other label" });
    expect(again).toEqual({ source: first.source, created: false });
    expect(await repository.getSource(scopeA, first.source.sourceId)).toEqual(first.source);

    const paused = await repository.createSource(scopeA, { kind: "slack", externalRef: "T1/C2", label: "B", status: "paused" });
    expect(paused.source.status).toBe("paused");
    const page = await repository.listSources(scopeA, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0]?.sourceId);
    const rest = await repository.listSources(scopeA, { limit: 1, cursor: page.nextCursor });
    expect(rest.nextCursor).toBeNull();
    expect([page.items[0]?.sourceId, rest.items[0]?.sourceId].sort())
      .toEqual([first.source.sourceId, paused.source.sourceId].sort());

    harness.tick();
    const { sourceId } = first.source;
    const updated = await repository.updateSource(scopeA, { sourceId, expectedRevision: 1, label: "Engineering", status: "paused" });
    expect(updated).toMatchObject({ label: "Engineering", status: "paused", revision: 2, updatedAt: harness.iso() });
    await expectBrainError(repository.updateSource(scopeA, { sourceId, expectedRevision: 1, label: "Stale" }), "conflict");
    await expectBrainError(repository.updateSource(scopeA, { sourceId, expectedRevision: 2 }), "invalid");
    await expectBrainError(repository.createSource(scopeA, { kind: "Slack", externalRef: "x", label: "x" }), "invalid");
    await expectBrainError(repository.createSource(scopeA, { kind: "slack", externalRef: "", label: "x" }), "invalid");
    await expectBrainError(repository.createSource(scopeA, { kind: "slack", externalRef: "T\u00001", label: "x" }), "invalid");
    await expectBrainError(repository.createSource(scopeA, { kind: "slack", externalRef: "x", label: "a\u0000b" }), "invalid");
    await expectBrainError(repository.updateSource(scopeA, { sourceId, expectedRevision: 2, label: "a\u0000b" }), "invalid");
    await expectBrainError(repository.getSource(scopeA, "not-an-id"), "invalid");
    await expectBrainError(repository.listSources(scopeA, { limit: 101 }), "invalid");
    await expectBrainError(repository.listSources(scopeA, { cursor: "src_\u0000" }), "invalid");
    const missing = `src_${"0".repeat(32)}`;
    await expectBrainError(repository.updateSource(scopeA, { sourceId: missing, expectedRevision: 1, label: "x" }), "not_found");
    await expectBrainError(repository.deleteSource(scopeA, { sourceId: missing, expectedRevision: 1 }), "not_found");
  });

  it("tombstones a source, purges its content and history, and keeps receipts", async () => {
    const { repository, db } = harness;
    const sourceId = await seedBrainScope(harness, scopeA);
    const manual = await repository.upsertDocument(scopeA, manualDocument("manual"));
    const receipt = (await repository.listSyncReceipts(scopeA, sourceId))[0]!;
    await repository.closeSyncReceipt(scopeA, {
      sourceId, receiptId: receipt.receiptId, status: "succeeded",
      counts: { read: 1, written: 1, unchanged: 0, deleted: 0, failed: 0 },
    });
    expect(await repository.listRevisions(scopeA, brainDocumentId("seed"))).toHaveLength(1);
    harness.tick();
    const running = await repository.openSyncReceipt(scopeA, { sourceId });

    harness.tick();
    const deleted = await repository.deleteSource(scopeA, { sourceId, expectedRevision: 1 });
    expect(deleted).toMatchObject({ sourceId, revision: 2, deletedAt: harness.iso() });
    expect(await repository.getSource(scopeA, sourceId)).toBeNull();
    expect((await repository.listSources(scopeA)).items).toEqual([]);
    expect(await repository.getDocument(scopeA, brainDocumentId("seed"))).toBeNull();
    const row = await db.selectFrom("brain_documents").selectAll()
      .where("owner_id", "=", "owner_a").where("scope_id", "=", "scope_a")
      .where("document_id", "=", brainDocumentId("seed")).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ title: "", body: "", permalink: "", byte_count: 0, revision: 3, source_id: sourceId });
    expect(row.deleted_at).not.toBeNull();
    expect(await repository.listRevisions(scopeA, brainDocumentId("seed"))).toEqual([]);
    expect(await repository.getSyncCursor(scopeA, sourceId)).toBeNull();
    expect(await countBrainRows(db, "brain_sync_cursors", scopeA)).toBe(0);
    expect(await countBrainRows(db, "brain_document_refs", scopeA)).toBe(0);
    // Nothing can open another receipt for a tombstoned source, so the delete closes the running one.
    expect((await repository.listSyncReceipts(scopeA, sourceId)).map((r) => [r.receiptId, r.status, r.finishedAt]))
      .toEqual([[running.receiptId, "interrupted", harness.iso()], [receipt.receiptId, "succeeded", BRAIN_CLOCK_START]]);
    expect(await repository.getDocument(scopeA, manual.document.documentId)).toEqual(manual.document);
    await expectBrainError(repository.deleteSource(scopeA, { sourceId, expectedRevision: 2 }), "not_found");
    await expectBrainError(repository.updateSource(scopeA, { sourceId, expectedRevision: 2, label: "x" }), "not_found");
    await expectBrainError(repository.upsertDocument(scopeA, { ...brainContent("new"), sourceId }), "not_found");

    const replacement = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "Seed" });
    expect(replacement.created).toBe(true);
    expect(replacement.source.sourceId).not.toBe(sourceId);
    await expectBrainError(
      repository.deleteSource(scopeA, { sourceId: replacement.source.sourceId, expectedRevision: 9 }), "conflict",
    );
  });

  it("upserts documents with content hashing, CAS and bounded inputs", async () => {
    const { repository } = harness;
    const input = manualDocument("alpha");
    const { documentId } = input;
    const created = await repository.upsertDocument(scopeA, input);
    expect(created.outcome).toBe("created");
    expect(created.document).toMatchObject({
      ownerId: "owner_a", scopeId: "scope_a", documentId, sourceId: null, revision: 1, title: "Title alpha",
      body: "Body for alpha", permalink: "", provenance: "manual", byteCount: 25, deletedAt: null,
      contentHash: computeBrainContentHash("Title alpha", "Body for alpha"),
      publishedAt: BRAIN_CLOCK_START, updatedAt: BRAIN_CLOCK_START, sourceUpdatedAt: BRAIN_CLOCK_START,
    });
    expect(created.document.incarnation).toMatch(UUID);
    expect(await repository.getDocument(scopeA, documentId)).toEqual(created.document);

    const unchanged = await repository.upsertDocument(scopeA, { ...input, sourceUpdatedAt: "2026-10-02T00:00:00+02:00" });
    expect(unchanged).toEqual({ outcome: "unchanged", document: created.document });

    harness.tick();
    const updated = await repository.upsertDocument(scopeA, { ...input, body: "Body v2" });
    expect(updated.outcome).toBe("updated");
    expect(updated.document).toMatchObject({
      revision: 2, body: "Body v2", incarnation: created.document.incarnation,
      publishedAt: BRAIN_CLOCK_START, updatedAt: harness.iso(),
    });
    const revisions = await repository.listRevisions(scopeA, documentId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      scopeId: "scope_a", documentId, revision: 1, change: "updated", body: "Body for alpha",
      incarnation: created.document.incarnation, supersededAt: harness.iso(),
    });
    const permalinked = await repository.upsertDocument(scopeA, { ...input, body: "Body v2", permalink: "https://example.com/a" });
    expect(permalinked.outcome).toBe("updated");
    expect(permalinked.document.revision).toBe(3);

    await expectBrainError(repository.upsertDocument(scopeA, { ...input, body: "v4", expectedRevision: 0 }), "conflict");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, body: "v4", expectedRevision: 1 }), "conflict");
    const cas = await repository.upsertDocument(scopeA, { ...input, body: "v4", expectedRevision: 3 });
    expect(cas.document.revision).toBe(4);
    await expectBrainError(repository.upsertDocument(scopeA, { ...manualDocument("fresh"), expectedRevision: 1 }), "conflict");

    const { source } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "S" });
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, sourceId: source.sourceId }), "conflict");
    await expectBrainError(
      repository.upsertDocument(scopeA, { ...brainContent("beta"), sourceId: `src_${"0".repeat(32)}` }), "not_found",
    );
    const sourced = await repository.upsertDocument(scopeA, { ...brainContent("beta"), sourceId: source.sourceId });
    expect(sourced.document.sourceId).toBe(source.sourceId);

    await expectBrainError(repository.upsertDocument(scopeA, { ...input, documentId: "nope" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, body: "x".repeat(65_537) }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, title: "t".repeat(301) }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, title: "   " }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, extra: true } as never), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: "http://example.com" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: "https://u:p@example.com" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: "not a url" }), "invalid");
    // Permalinks must already be canonical (`new URL(v).href === v`): no padding, control chars, or uppercase scheme.
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: " https://x.example/p" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: "https://x.example/p\n" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: "https://x.example/\t" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: "HTTPS://x.example/p" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, permalink: "https://x.example" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, sourceUpdatedAt: "yesterday" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, provenance: "Manual!" }), "invalid");
    await expectBrainError(repository.upsertDocument({ ownerId: "o", scopeId: "" }, input), "invalid");
    // U+0000 is refused before SQL so it never surfaces as a raw Postgres 22021 error.
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, body: "a\u0000b" }), "invalid");
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, title: "a\u0000b" }), "invalid");
    await expectBrainError(repository.upsertDocument({ ownerId: "o\u0000", scopeId: "s" }, input), "invalid");
    await expectBrainError(repository.upsertDocument({ ownerId: "o", scopeId: "s\u0000" }, input), "invalid");
    const bytes = "\u00e9".repeat(32_767);
    await expectBrainError(repository.upsertDocument(scopeA, { ...input, title: "abc", body: bytes }), "invalid");
    expect((await repository.upsertDocument(scopeA, { ...input, title: "ab", body: bytes })).document.byteCount).toBe(65_536);
  });

  it("revises documents with a mandatory CAS and merged byte limit", async () => {
    const { repository } = harness;
    const input = manualDocument("rev");
    const { documentId } = input;
    await repository.upsertDocument(scopeA, input);
    harness.tick();
    const revised = await repository.reviseDocument(scopeA, {
      documentId, expectedRevision: 1, title: "Renamed", permalink: "https://example.com/r", sourceUpdatedAt: "2026-10-01T11:00:00.000Z",
    });
    expect(revised).toMatchObject({
      revision: 2, title: "Renamed", body: "Body for rev", permalink: "https://example.com/r",
      sourceUpdatedAt: "2026-10-01T11:00:00.000Z", updatedAt: harness.iso(), contentHash: computeBrainContentHash("Renamed", "Body for rev"),
    });
    const same = await repository.reviseDocument(scopeA, { documentId, expectedRevision: 2, body: "Body for rev" });
    expect(same.revision).toBe(3);
    expect((await repository.listRevisions(scopeA, documentId)).map((r) => r.revision)).toEqual([2, 1]);
    await expectBrainError(repository.reviseDocument(scopeA, { documentId, expectedRevision: 1, body: "x" }), "conflict");
    await expectBrainError(repository.reviseDocument(scopeA, { documentId, expectedRevision: 3 }), "invalid");
    await expectBrainError(repository.reviseDocument(scopeA, { documentId, expectedRevision: 3, title: "" }), "invalid");
    await repository.reviseDocument(scopeA, { documentId, expectedRevision: 3, body: "y".repeat(65_529) });
    await expectBrainError(repository.reviseDocument(scopeA, { documentId, expectedRevision: 4, title: "t".repeat(8) }), "invalid");
    expect((await repository.getDocument(scopeA, documentId))?.revision).toBe(4);
    await expectBrainError(repository.reviseDocument(scopeA, { documentId: brainDocumentId("x"), expectedRevision: 1, body: "b" }), "not_found");
    await repository.deleteDocument(scopeA, { documentId });
    await expectBrainError(repository.reviseDocument(scopeA, { documentId, expectedRevision: 5, body: "b" }), "not_found");
  });

  it("tombstones documents and recreates them under a new incarnation", async () => {
    const { repository, db } = harness;
    const input = manualDocument("gamma");
    const { documentId } = input;
    const created = await repository.upsertDocument(scopeA, input);
    harness.tick();
    await repository.upsertDocument(scopeA, { ...input, body: "v2" });
    harness.tick();
    const tombstone = await repository.deleteDocument(scopeA, { documentId, expectedRevision: 2 });
    expect(tombstone).toMatchObject({
      documentId, revision: 3, title: "", body: "", permalink: "", byteCount: 0, deletedAt: harness.iso(),
      incarnation: created.document.incarnation, publishedAt: BRAIN_CLOCK_START,
      contentHash: computeBrainContentHash("", ""), provenance: "manual", sourceId: null,
    });
    const row = await db.selectFrom("brain_documents").selectAll()
      .where("owner_id", "=", "owner_a").where("scope_id", "=", "scope_a")
      .where("document_id", "=", documentId).executeTakeFirstOrThrow();
    expect(row.incarnation).toBe(created.document.incarnation);
    expect(new Date(row.published_at).toISOString()).toBe(BRAIN_CLOCK_START);
    expect(row.deleted_at).not.toBeNull();
    expect(await repository.getDocument(scopeA, documentId)).toBeNull();
    expect((await repository.listDocuments(scopeA)).items).toEqual([]);
    expect(await repository.searchDocuments(scopeA, { query: "gamma" })).toEqual([]);
    await expectBrainError(repository.deleteDocument(scopeA, { documentId }), "not_found");
    expect((await repository.listRevisions(scopeA, documentId)).map((r) => [r.revision, r.change, r.body]))
      .toEqual([[2, "deleted", "v2"], [1, "updated", "Body for gamma"]]);

    harness.tick();
    const recreated = await repository.upsertDocument(scopeA, { ...input, body: "v3", expectedRevision: 0 });
    expect(recreated.outcome).toBe("created");
    expect(recreated.document).toMatchObject({ revision: 1, body: "v3", publishedAt: harness.iso(), deletedAt: null });
    expect(recreated.document.incarnation).not.toBe(created.document.incarnation);
    expect(await repository.listRevisions(scopeA, documentId)).toHaveLength(2);
    await expectBrainError(repository.deleteDocument(scopeA, { documentId, expectedRevision: 5 }), "conflict");
    expect((await repository.deleteDocument(scopeA, { documentId })).revision).toBe(2);
  });

  it("keeps at most ten revision snapshots per document", async () => {
    const { repository, db } = harness;
    const input = manualDocument("delta");
    await repository.upsertDocument(scopeA, input);
    for (let index = 1; index <= 12; index += 1) {
      harness.tick();
      await repository.upsertDocument(scopeA, { ...input, body: `v${index}` });
    }
    const revisions = await repository.listRevisions(scopeA, input.documentId);
    expect(revisions.map((revision) => revision.revision)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(await countBrainRows(db, "brain_document_revisions", scopeA)).toBe(10);
  });

  it("verifies evidence proofs against live incarnations and revisions", async () => {
    const { repository } = harness;
    const a = (await repository.upsertDocument(scopeA, manualDocument("a"))).document;
    const b = (await repository.upsertDocument(scopeA, manualDocument("b"))).document;
    const proof = (document: typeof a, revision = document.revision): BrainEvidenceProof =>
      ({ documentId: document.documentId, incarnation: document.incarnation, revision });
    await repository.assertCurrent(scopeA, []);
    await repository.assertCurrent(scopeA, [proof(a), proof(a), proof(b)]);
    await expectBrainError(repository.assertCurrent(scopeA, [proof(a, 2)]), "forbidden");
    await expectBrainError(repository.assertCurrent(scopeA, [{ ...proof(a), incarnation: randomUUID() }]), "forbidden");
    await expectBrainError(repository.assertCurrent(scopeA, [{ ...proof(a), documentId: brainDocumentId("zz") }]), "forbidden");
    await expectBrainError(repository.assertCurrent(scopeB, [proof(a)]), "forbidden");
    await repository.deleteDocument(scopeA, { documentId: b.documentId });
    await expectBrainError(repository.assertCurrent(scopeA, [proof(a), proof(b)]), "forbidden");
    await repository.assertCurrent(scopeA, [proof(a)]);
    await expectBrainError(repository.assertCurrent(scopeA, Array.from({ length: 101 }, () => proof(a))), "invalid");
    await expectBrainError(repository.assertCurrent(scopeA, [proof(a, 0)]), "invalid");
    await expectBrainError(repository.assertCurrent(scopeA, [{ ...proof(a), incarnation: "nope" }]), "invalid");
  });

  it("searches live documents in scope with bounded limits and no bodies", async () => {
    const { repository } = harness;
    const roadmap = manualDocument("roadmap", { title: "Quarterly roadmap", body: "Ship the brain store in October" });
    await repository.upsertDocument(scopeA, roadmap);
    await repository.upsertDocument(scopeA, manualDocument("lunch", { title: "Lunch menu", body: "Tacos on Friday" }));
    await repository.upsertDocument(scopeB, manualDocument("other", { title: "Roadmap elsewhere", body: "October plans" }));
    const hits = await repository.searchDocuments(scopeA, { query: "roadmap october" });
    expect(hits.map((hit) => hit.documentId)).toEqual([roadmap.documentId]);
    expect(hits[0]).not.toHaveProperty("body");
    expect(hits[0]).toMatchObject({ title: "Quarterly roadmap", scopeId: "scope_a", ownerId: "owner_a" });
    expect(await repository.searchDocuments(scopeA, { query: "nothing matches" })).toEqual([]);
    for (const seed of ["s1", "s2", "s3"]) {
      harness.tick();
      await repository.upsertDocument(scopeA, manualDocument(seed, { body: `shared term ${seed}` }));
    }
    const limited = await repository.searchDocuments(scopeA, { query: "shared", limit: 2 });
    expect(limited.map((hit) => hit.title)).toEqual(["Title s3", "Title s2"]);
    expect(await repository.searchDocuments(scopeA, { query: "shared" })).toHaveLength(3);
    await repository.deleteDocument(scopeA, { documentId: roadmap.documentId });
    expect(await repository.searchDocuments(scopeA, { query: "roadmap" })).toEqual([]);
    await expectBrainError(repository.searchDocuments(scopeA, { query: "x", limit: 51 }), "invalid");
    await expectBrainError(repository.searchDocuments(scopeA, { query: "   " }), "invalid");
    await expectBrainError(repository.searchDocuments(scopeA, { query: "q".repeat(501) }), "invalid");
    await expectBrainError(repository.searchDocuments(scopeA, { query: "a\u0000b" }), "invalid");
  });

  it("lists document summaries by keyset with an optional source filter", async () => {
    const { repository } = harness;
    const { source } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "S" });
    const ids = ["p1", "p2", "p3"].map((seed) => brainDocumentId(seed)).sort();
    for (const seed of ["p1", "p2"]) await repository.upsertDocument(scopeA, manualDocument(seed));
    await repository.upsertDocument(scopeA, { ...brainContent("p3"), sourceId: source.sourceId });
    const first = await repository.listDocuments(scopeA, { limit: 2 });
    expect(first.items.map((item) => item.documentId)).toEqual(ids.slice(0, 2));
    expect(first.items[0]).not.toHaveProperty("body");
    expect(first.nextCursor).toBe(ids[1]);
    const second = await repository.listDocuments(scopeA, { limit: 2, cursor: first.nextCursor });
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map((item) => item.documentId)).toEqual(ids.slice(2));
    const filtered = await repository.listDocuments(scopeA, { sourceId: source.sourceId });
    expect(filtered.items.map((item) => item.documentId)).toEqual([brainDocumentId("p3")]);
    await expectBrainError(repository.listDocuments(scopeA, { limit: 0 }), "invalid");
    await expectBrainError(repository.listDocuments(scopeA, { sourceId: "bad" }), "invalid");
    await expectBrainError(repository.listRevisions(scopeA, "bad"), "invalid");
  });
});
