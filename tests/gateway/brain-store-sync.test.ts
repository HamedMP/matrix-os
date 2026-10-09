import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrainRepository,
  type BrainDatabase,
  type BrainSyncBatchInput,
} from "../../packages/gateway/src/brain/index.js";
import {
  BRAIN_CLOCK_START,
  BRAIN_TABLES,
  brainContent,
  brainDocumentId,
  countBrainRows,
  createBrainHarness,
  expectBrainError,
  manualDocument,
  scopeA,
  scopeB,
  seedBrainScope,
  zeroCounts,
  type BrainHarness,
} from "./helpers/brain-store-helpers.js";

const MISSING_SOURCE = `src_${"0".repeat(32)}`;

function batch(sourceId: string, overrides: Partial<BrainSyncBatchInput> = {}): BrainSyncBatchInput {
  return { sourceId, expectedCursor: null, nextCursor: "c1", upserts: [], deletions: [], ...overrides };
}

describe("brain store sync", () => {
  let harness: BrainHarness;

  beforeEach(async () => {
    harness = await createBrainHarness();
  });

  afterEach(() => harness.destroy());

  it("applies batches atomically with cursor CAS, ownership checks and idempotent replays", async () => {
    const { repository, db } = harness;
    const { source } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "Slack" });
    const { sourceId } = source;
    const one = brainContent("one", { provenance: "slack_thread", permalink: "https://slack.example.com/p1" });
    const two = brainContent("two", { provenance: "slack_thread" });

    const first = await repository.applySyncBatch(scopeA, batch(sourceId, { upserts: [one, two] }));
    expect(first).toEqual({
      cursor: { scopeId: "scope_a", sourceId, cursor: "c1", updatedAt: harness.iso() },
      created: 2, updated: 0, unchanged: 0, refsChanged: 0, restamped: 0, deleted: 0, rejected: [],
    });
    expect(await repository.getSyncCursor(scopeA, sourceId)).toEqual(first.cursor);
    expect(await repository.getDocument(scopeA, one.documentId)).toMatchObject({
      sourceId, revision: 1, provenance: "slack_thread", permalink: "https://slack.example.com/p1",
    });

    harness.tick();
    const replay = await repository.applySyncBatch(scopeA, batch(sourceId, { expectedCursor: "c1", upserts: [one, two] }));
    expect(replay).toMatchObject({ created: 0, updated: 0, unchanged: 2, deleted: 0, rejected: [] });
    expect(replay.cursor).toEqual({ scopeId: "scope_a", sourceId, cursor: "c1", updatedAt: harness.iso() });

    const three = brainContent("three");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, { nextCursor: "c2", upserts: [three] })), "conflict");
    await expectBrainError(
      repository.applySyncBatch(scopeA, batch(sourceId, { expectedCursor: "c0", nextCursor: "c2", upserts: [three] })), "conflict",
    );
    expect(await repository.getDocument(scopeA, three.documentId)).toBeNull();
    expect(await countBrainRows(db, "brain_documents", scopeA)).toBe(2);
    expect((await repository.getSyncCursor(scopeA, sourceId))?.cursor).toBe("c1");

    const manual = (await repository.upsertDocument(scopeA, manualDocument("manual"))).document;
    const { source: other } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/D", label: "Other" });
    const foreign = await repository.applySyncBatch(scopeA, batch(other.sourceId, {
      nextCursor: "o1",
      upserts: [{ ...one, body: "hijack" }, { ...brainContent("manual"), body: "hijack" }, brainContent("four")],
      deletions: [two.documentId, brainDocumentId("missing")],
    }));
    expect(foreign).toMatchObject({
      created: 1, updated: 0, unchanged: 0, deleted: 0, rejected: [one.documentId, manual.documentId],
    });
    expect((await repository.getDocument(scopeA, one.documentId))?.body).toBe("Body for one");
    expect((await repository.getDocument(scopeA, manual.documentId))?.body).toBe("Body for manual");
    expect((await repository.getDocument(scopeA, two.documentId))?.deletedAt).toBeNull();

    harness.tick();
    const own = await repository.applySyncBatch(scopeA, batch(sourceId, {
      expectedCursor: "c1", nextCursor: "c2", upserts: [{ ...one, body: "v2" }], deletions: [two.documentId],
    }));
    expect(own).toMatchObject({ created: 0, updated: 1, unchanged: 0, deleted: 1, rejected: [] });
    expect((await repository.getDocument(scopeA, one.documentId))?.revision).toBe(2);
    expect(await repository.getDocument(scopeA, two.documentId)).toBeNull();
    expect((await repository.listRevisions(scopeA, two.documentId)).map((r) => r.change)).toEqual(["deleted"]);
    const replayDelete = await repository.applySyncBatch(scopeA, batch(sourceId, {
      expectedCursor: "c2", nextCursor: "c3", deletions: [two.documentId],
    }));
    expect(replayDelete.deleted).toBe(0);

    const revive = await repository.applySyncBatch(scopeA, batch(other.sourceId, {
      expectedCursor: "o1", nextCursor: "o2", upserts: [two],
    }));
    expect(revive.created).toBe(1);
    expect(await repository.getDocument(scopeA, two.documentId)).toMatchObject({ sourceId: other.sourceId, revision: 1 });

    await repository.updateSource(scopeA, { sourceId, expectedRevision: 1, status: "paused" });
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, { expectedCursor: "c3", nextCursor: "c4" })), "conflict");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(MISSING_SOURCE)), "not_found");
    await expectBrainError(repository.applySyncBatch(scopeB, batch(sourceId)), "not_found");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, { upserts: [one, one] })), "invalid");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, { deletions: [two.documentId, two.documentId] })), "invalid");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, {
      upserts: Array.from({ length: 201 }, (_, index) => brainContent(`bulk-${index}`)),
    })), "invalid");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, { nextCursor: "" })), "invalid");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, { expectedCursor: "x".repeat(2049) })), "invalid");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, { nextCursor: "c\u00001" })), "invalid");
    await expectBrainError(repository.applySyncBatch(scopeA, batch(sourceId, {
      upserts: [{ ...one, body: "" }],
    })), "invalid");
    await expectBrainError(repository.getSyncCursor(scopeA, "bad"), "invalid");
  });

  it("records the source's newest stamp on an unchanged synced document without a new revision", async () => {
    const { repository } = harness;
    const { source } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "Slack" });
    const one = brainContent("one", { provenance: "slack_thread", sourceUpdatedAt: "2026-09-01T00:00:00.000Z" });
    await repository.applySyncBatch(scopeA, batch(source.sourceId, { upserts: [one] }));
    const before = await repository.getDocument(scopeA, one.documentId);

    harness.tick();
    const touched = await repository.applySyncBatch(scopeA, batch(source.sourceId, {
      expectedCursor: "c1", nextCursor: "c2", upserts: [{ ...one, sourceUpdatedAt: "2026-09-02T00:00:00.000Z" }],
    }));
    expect(touched).toMatchObject({ created: 0, updated: 0, unchanged: 1, restamped: 1 });
    expect(await repository.getDocument(scopeA, one.documentId))
      .toEqual({ ...before, sourceUpdatedAt: "2026-09-02T00:00:00.000Z" });
    expect(await repository.listRevisions(scopeA, one.documentId)).toEqual([]);

    // A manual upsert keeps its contract: unchanged content writes nothing.
    const manual = (await repository.upsertDocument(scopeA, manualDocument("manual"))).document;
    const again = await repository.upsertDocument(scopeA, manualDocument("manual", { sourceUpdatedAt: "2026-09-03T00:00:00.000Z" }));
    expect(again).toEqual({ outcome: "unchanged", document: manual });
  });

  it("rolls back the whole batch when capacity is exceeded", async () => {
    const capped = await createBrainHarness({ maxDocumentsPerScope: 2 });
    try {
      const { repository, db } = capped;
      const { source } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "Slack" });
      const upserts = ["a", "b", "c"].map((seed) => brainContent(seed));
      await expectBrainError(repository.applySyncBatch(scopeA, batch(source.sourceId, { upserts })), "capacity");
      expect(await countBrainRows(db, "brain_documents", scopeA)).toBe(0);
      expect(await repository.getSyncCursor(scopeA, source.sourceId)).toBeNull();
      const partial = await repository.applySyncBatch(scopeA, batch(source.sourceId, { upserts: upserts.slice(0, 2) }));
      expect(partial.created).toBe(2);
      await expectBrainError(repository.applySyncBatch(scopeA, batch(source.sourceId, {
        expectedCursor: "c1", nextCursor: "c2", upserts: [upserts[2]!], deletions: [upserts[0]!.documentId],
      })), "capacity");
      expect((await repository.getDocument(scopeA, upserts[0]!.documentId))?.deletedAt).toBeNull();
      expect((await repository.getSyncCursor(scopeA, source.sourceId))?.cursor).toBe("c1");
    } finally {
      await capped.destroy();
    }
  });

  it("records receipts, interrupts stale runs, closes once and prunes to fifty", async () => {
    const { repository, db } = harness;
    const { source } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "Slack" });
    const { sourceId } = source;
    const opened = await repository.openSyncReceipt(scopeA, { sourceId });
    expect(opened).toMatchObject({
      scopeId: "scope_a", sourceId, status: "running", counts: zeroCounts, nextAction: "", errorCode: null,
      cursorBefore: null, cursorAfter: null, startedAt: harness.iso(), finishedAt: null,
    });
    expect(opened.receiptId).toMatch(/^rcp_[a-f0-9]{32}$/);
    const noCursor = await repository.closeSyncReceipt(scopeA, {
      sourceId, receiptId: opened.receiptId, status: "succeeded", counts: zeroCounts,
    });
    expect(noCursor).toMatchObject({ status: "succeeded", cursorBefore: null, cursorAfter: null, finishedAt: harness.iso() });
    harness.tick();
    const reopened = await repository.openSyncReceipt(scopeA, { sourceId });

    harness.tick();
    await repository.applySyncBatch(scopeA, batch(sourceId));
    const second = await repository.openSyncReceipt(scopeA, { sourceId });
    expect(second.cursorBefore).toBe("c1");
    expect((await repository.listSyncReceipts(scopeA, sourceId)).map((r) => [r.receiptId, r.status, r.finishedAt]))
      .toEqual([
        [second.receiptId, "running", null],
        [reopened.receiptId, "interrupted", harness.iso()],
        [opened.receiptId, "succeeded", noCursor.finishedAt],
      ]);
    expect(await repository.listSyncReceipts(scopeA, sourceId, { limit: 1 })).toHaveLength(1);

    harness.tick();
    await repository.applySyncBatch(scopeA, batch(sourceId, { expectedCursor: "c1", nextCursor: "c2" }));
    const counts = { read: 5, written: 3, unchanged: 1, deleted: 0, failed: 1 };
    const closed = await repository.closeSyncReceipt(scopeA, {
      sourceId, receiptId: second.receiptId, status: "partial", counts, nextAction: "retry_after_backoff", errorCode: "rate_limited",
    });
    expect(closed).toMatchObject({
      receiptId: second.receiptId, status: "partial", counts, nextAction: "retry_after_backoff", errorCode: "rate_limited",
      cursorBefore: "c1", cursorAfter: "c2", startedAt: second.startedAt, finishedAt: harness.iso(),
    });
    expect((await repository.listSyncReceipts(scopeA, sourceId))[0]).toEqual(closed);
    const close = { sourceId, receiptId: second.receiptId, status: "succeeded" as const, counts: zeroCounts };
    await expectBrainError(repository.closeSyncReceipt(scopeA, close), "conflict");
    await expectBrainError(repository.closeSyncReceipt(scopeA, { ...close, receiptId: `rcp_${"0".repeat(32)}` }), "not_found");
    await expectBrainError(repository.closeSyncReceipt(scopeB, close), "not_found");
    await expectBrainError(repository.closeSyncReceipt(scopeA, { ...close, receiptId: "bad" }), "invalid");
    await expectBrainError(
      repository.closeSyncReceipt(scopeA, { ...close, errorCode: "Error: ECONNRESET at Socket" }), "invalid",
    );
    await expectBrainError(repository.closeSyncReceipt(scopeA, { ...close, counts: { ...zeroCounts, read: -1 } }), "invalid");
    await expectBrainError(repository.closeSyncReceipt(scopeA, { ...close, nextAction: "n".repeat(501) }), "invalid");
    await expectBrainError(
      repository.closeSyncReceipt(scopeA, { ...close, nextAction: "Error: ECONNRESET at Socket" }), "invalid",
    );
    await expectBrainError(repository.closeSyncReceipt(scopeA, { ...close, status: "running" as never }), "invalid");
    await expectBrainError(repository.listSyncReceipts(scopeA, sourceId, { limit: 51 }), "invalid");

    const third = await repository.openSyncReceipt(scopeA, { sourceId });
    const failed = await repository.closeSyncReceipt(scopeA, {
      sourceId, receiptId: third.receiptId, status: "failed", counts: zeroCounts, errorCode: "slack_unreachable", nextAction: "reconnect_slack",
    });
    expect(failed).toMatchObject({ status: "failed", errorCode: "slack_unreachable", nextAction: "reconnect_slack", cursorAfter: "c2" });

    for (let index = 0; index < 55; index += 1) {
      harness.tick();
      const receipt = await repository.openSyncReceipt(scopeA, { sourceId });
      await repository.closeSyncReceipt(scopeA, { sourceId, receiptId: receipt.receiptId, status: "succeeded", counts: zeroCounts });
    }
    expect(await countBrainRows(db, "brain_sync_receipts", scopeA)).toBe(50);
    const retained = await repository.listSyncReceipts(scopeA, sourceId);
    expect(retained).toHaveLength(50);
    expect(retained.every((receipt) => receipt.status === "succeeded")).toBe(true);
    expect(retained[0]?.startedAt).toBe(harness.iso());

    await repository.updateSource(scopeA, { sourceId, expectedRevision: 1, status: "disabled" });
    await expectBrainError(repository.openSyncReceipt(scopeA, { sourceId }), "conflict");
    await expectBrainError(repository.openSyncReceipt(scopeA, { sourceId: MISSING_SOURCE }), "not_found");
    await expectBrainError(repository.openSyncReceipt(scopeB, { sourceId }), "not_found");
    await expectBrainError(repository.openSyncReceipt(scopeA, { sourceId: "bad" }), "invalid");
  });

  it("erases every row of one scope and leaves other scopes intact", async () => {
    const { repository, db } = harness;
    await seedBrainScope(harness, scopeA);
    const sourceB = await seedBrainScope(harness, scopeB);
    const before = (await repository.getDocument(scopeA, brainDocumentId("seed")))!;
    await repository.eraseScope(scopeA);
    for (const table of BRAIN_TABLES) {
      expect(await countBrainRows(db, table, scopeA)).toBe(0);
      expect(await countBrainRows(db, table, scopeB)).toBe(1);
    }
    expect(await repository.getDocument(scopeB, brainDocumentId("seed"))).toMatchObject({ sourceId: sourceB, revision: 2 });
    await repository.eraseScope(scopeA);
    const sourceAgain = await seedBrainScope(harness, scopeA);
    const after = (await repository.getDocument(scopeA, brainDocumentId("seed")))!;
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(after.sourceId).not.toBe(before.sourceId);
    expect(after.sourceId).toBe(sourceAgain);
    await expectBrainError(repository.eraseScope({ ownerId: "x".repeat(257), scopeId: "s" }), "invalid");
  });

  it("purges a deleted source's snapshots even after another source revived the document id", async () => {
    const { repository, db } = harness;
    const { source: a } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/A", label: "A" });
    const { source: b } = await repository.createSource(scopeA, { kind: "slack", externalRef: "T/B", label: "B" });
    const x = brainContent("x", { body: "SECRET from A" });
    const note = manualDocument("note", { body: "manual v1" });
    await repository.upsertDocument(scopeA, note);
    await repository.applySyncBatch(scopeA, batch(a.sourceId, { upserts: [x] }));
    harness.tick();
    await repository.upsertDocument(scopeA, { ...note, body: "manual v2" });
    await repository.applySyncBatch(scopeA, batch(a.sourceId, { expectedCursor: "c1", nextCursor: "c2", deletions: [x.documentId] }));
    harness.tick();
    await repository.applySyncBatch(scopeA, batch(b.sourceId, { nextCursor: "b1", upserts: [{ ...x, body: "From B v1" }] }));
    harness.tick();
    await repository.applySyncBatch(scopeA, batch(b.sourceId, {
      expectedCursor: "b1", nextCursor: "b2", upserts: [{ ...x, body: "From B v2" }],
    }));
    expect((await repository.listRevisions(scopeA, x.documentId)).map((r) => r.body)).toEqual(["From B v1", "SECRET from A"]);
    const snapshots = await db.selectFrom("brain_document_revisions").select(["body", "source_id"])
      .where("owner_id", "=", "owner_a").where("scope_id", "=", "scope_a").execute();
    expect(snapshots).toHaveLength(3);
    expect(snapshots).toEqual(expect.arrayContaining([
      { body: "manual v1", source_id: null },
      { body: "SECRET from A", source_id: a.sourceId },
      { body: "From B v1", source_id: b.sourceId },
    ]));

    harness.tick();
    await repository.deleteSource(scopeA, { sourceId: a.sourceId, expectedRevision: 1 });
    expect((await repository.listRevisions(scopeA, x.documentId)).map((r) => r.body)).toEqual(["From B v1"]);
    expect(await repository.getDocument(scopeA, x.documentId)).toMatchObject({ sourceId: b.sourceId, body: "From B v2", revision: 2 });
    expect((await repository.listRevisions(scopeA, note.documentId)).map((r) => r.body)).toEqual(["manual v1"]);
    expect(await countBrainRows(db, "brain_document_revisions", scopeA)).toBe(2);
  });

  it("reads the clock only after the scope lock is held, and never on reads", async () => {
    const pglite = await KyselyPGlite.create();
    const events: string[] = [];
    const shared = new Kysely<BrainDatabase>({
      dialect: pglite.dialect,
      log: (event) => { events.push(event.query.sql); },
    });
    const repository = new BrainRepository(shared, {
      now: () => { events.push("now()"); return new Date(BRAIN_CLOCK_START); },
    });
    try {
      await repository.bootstrap();
      events.length = 0;
      const { source } = await repository.createSource(scopeA, { kind: "manual", externalRef: "clock", label: "Clock" });
      const lock = events.findIndex((event) => event.includes("pg_advisory_xact_lock"));
      expect(lock).toBeGreaterThan(-1);
      expect(events.indexOf("now()")).toBeGreaterThan(lock);
      expect(events.filter((event) => event === "now()")).toHaveLength(1);
      events.length = 0;
      await repository.applySyncBatch(scopeA, batch(source.sourceId, { upserts: [brainContent("one")] }));
      expect(events.indexOf("now()")).toBeGreaterThan(events.findIndex((event) => event.includes("pg_advisory_xact_lock")));
      expect(events.filter((event) => event === "now()")).toHaveLength(1);
      events.length = 0;
      await repository.getSource(scopeA, source.sourceId);
      await repository.listSyncReceipts(scopeA, source.sourceId);
      await repository.searchDocuments(scopeA, { query: "one" });
      expect(events.length).toBeGreaterThan(0);
      expect(events).not.toContain("now()");
    } finally {
      await shared.destroy();
    }
  });
});
