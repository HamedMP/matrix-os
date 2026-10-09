/** The claim store on PGlite: replace, stale, write-time checks, caps, cleanup, isolation, the run fence and reads. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrainDocument, BrainDocumentContentInput } from "../../packages/gateway/src/brain/index.js";
import {
  computeBrainClaimId, type BrainClaimInput, type BrainClaimKind, type BrainDocumentExtractionOutcome, type BrainExtractionRun,
} from "../../packages/gateway/src/brain/claims/types.js";
import {
  BRAIN_CLOCK_START, brainContent, countBrainRows, createBrainHarness, expectBrainError, manualDocument, scopeA, scopeB,
  scopeOtherOwner, type BrainHarness,
} from "./helpers/brain-store-helpers.js";

const RULES = "rules/v1";
const MODEL = "model:fake/p1";
const [Q1, Q2, Q3] = ["**Source of truth**: owner Postgres \ud83e\udd16 tables.", "**Deferred scope**: the model adapter lands in #12.",
  "Keep spans in UTF-16 units."];
const BODY = ["## Invariants", `- ${Q1}`, `- ${Q2}`, "## Decisions", `- ${Q3}`].join("\n");
const ZERO_COUNTS = { documentsProcessed: 0, documentsFailed: 0, claimsWritten: 0, claimsRemoved: 0, claimsRejected: 0,
  quotesRejected: 0 };
const NO_USAGE = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
const FAILED: BrainDocumentExtractionOutcome = { status: "failed", errorCode: "extractor_error" };
const STALE = { applied: false, reason: "stale" };

type ClaimOptions = { kind?: BrainClaimKind; label?: string | null; statement?: string };
function claimOf(documentId: string, quote: string, options: ClaimOptions = {}): BrainClaimInput {
  const { kind = "invariant", label = null, statement = quote } = options;
  const spanStart = BODY.indexOf(quote);
  return { claimId: computeBrainClaimId(documentId, kind, label, statement), kind, label, statement, quote, spanStart,
    spanEnd: spanStart + quote.length, fields: {}, confidence: "high" };
}
const done = (...claims: BrainClaimInput[]): BrainDocumentExtractionOutcome => ({ status: "done", claims });

describe("brain claim store", () => {
  let harness: BrainHarness;
  beforeEach(async () => { harness = await createBrainHarness(); });
  afterEach(() => harness.destroy());

  const publish = async (seed: string, overrides: Partial<BrainDocumentContentInput> = {}): Promise<BrainDocument> =>
    (await harness.repository.upsertDocument(scopeA, manualDocument(seed, { body: BODY, ...overrides }))).document;
  const open = (extractor = RULES) => harness.repository.openExtractionRun(scopeA, { extractor });
  const close = (run: BrainExtractionRun) => harness.repository.closeExtractionRun(scopeA, {
    runId: run.runId, status: "succeeded", counts: ZERO_COUNTS, usage: NO_USAGE, nextAction: "", errorCode: null,
  });
  const apply = (run: BrainExtractionRun, document: BrainDocument, outcome: BrainDocumentExtractionOutcome, patch = {}) =>
    harness.repository.applyDocumentExtraction(scopeA, { runId: run.runId, documentId: document.documentId,
      incarnation: document.incarnation, revision: document.revision, extractor: run.extractor, outcome, ...patch });
  const states = (documentId: string) => harness.db.selectFrom("brain_extraction_state").orderBy("extractor")
    .select(["extractor", "status", "attempts", "error_code", "revision"]).where("document_id", "=", documentId).execute();
  const pending = async (extractor = RULES, maxAttempts = 3) => (await harness.repository
    .listPendingExtractions(scopeA, { extractor, limit: 10, maxAttempts })).items.map((item) => item.documentId);
  const claimIds = async (query = {}) =>
    (await harness.repository.listClaims(scopeA, { limit: 100, ...query })).items.map((item) => item.claim.claimId);
  const rowCounts = () => Promise.all((["brain_claims", "brain_extraction_state"] as const)
    .map((table) => countBrainRows(harness.db, table, scopeA)));

  it("replaces a document's claims per extractor, keeps created_at of surviving ids and isolates scopes", async () => {
    const document = await publish("a");
    const id = document.documentId;
    const run = await open();
    const truth = claimOf(id, Q1, { label: "Source of truth" });
    expect(await apply(run, document, done(truth, claimOf(id, Q2)))).toEqual({ applied: true, written: 2, removed: 0 });
    expect(await states(id)).toEqual([{ extractor: RULES, status: "done", attempts: 1, error_code: null, revision: 1 }]);
    harness.tick();
    const decision = { ...claimOf(id, Q3, { kind: "decision" }), fields: { severity: "high" as const, due: "2026-12-01" } };
    expect(await apply(run, document, done(truth, decision))).toEqual({ applied: true, written: 1, removed: 1 });
    const page = await harness.repository.listClaims(scopeA, {});
    expect(page.items.map(({ claim }) => [claim.quote, claim.createdAt, claim.stale, claim.fields])).toEqual([
      [Q1, BRAIN_CLOCK_START, false, {}], [Q3, harness.iso(), false, { severity: "high", due: "2026-12-01" }],
    ]);
    expect(BODY.slice(page.items[0]!.claim.spanStart, page.items[0]!.claim.spanEnd)).toBe(Q1);
    expect((await states(id))[0]?.attempts).toBe(2);
    await close(run);
    const modelRun = await open(MODEL);
    expect(await apply(modelRun, document, done(claimOf(id, Q1)))).toEqual({ applied: true, written: 1, removed: 0 });
    expect(await claimIds()).toHaveLength(3);
    expect((await states(id)).map((row) => row.extractor)).toEqual([MODEL, RULES]);
    for (const scope of [scopeB, scopeOtherOwner]) {
      const { repository } = harness;
      expect((await repository.listPendingExtractions(scope, { extractor: MODEL, limit: 10, maxAttempts: 3 })).items)
        .toEqual([]);
      expect((await repository.listClaims(scope, {})).items).toEqual([]);
      await expectBrainError(repository.applyDocumentExtraction(scope, { runId: modelRun.runId, documentId: id,
        incarnation: document.incarnation, revision: 1, extractor: MODEL, outcome: done() }), "conflict");
      expect(await countBrainRows(harness.db, "brain_extraction_runs", scope)).toBe(0);
      expect((await repository.openExtractionRun(scope, { extractor: MODEL })).status).toBe("running");
    }
  });

  it("validates claims at write time and caps claims per scope", async () => {
    const document = await publish("a");
    const id = document.documentId;
    const run = await open();
    const good = claimOf(id, Q1);
    const many = Array.from({ length: 51 }, (_, index) => claimOf(id, Q1, { statement: `statement ${index}` }));
    for (const outcome of [
      done({ ...good, spanStart: good.spanStart + 1, spanEnd: good.spanEnd + 1 }), done(...many), done(good, good),
      done({ ...good, claimId: claimOf(id, Q2).claimId }), done({ ...good, fields: { assignee: "bob\ud800" } }),
      { status: "failed", errorCode: "Not A Code" } as unknown as BrainDocumentExtractionOutcome,
    ]) await expectBrainError(apply(run, document, outcome), "invalid");
    expect(await countBrainRows(harness.db, "brain_extraction_state", scopeA)).toBe(0);

    await harness.destroy();
    harness = await createBrainHarness({ maxClaimsPerScope: 3 });
    const [first, second] = [await publish("a"), await publish("b")];
    const capped = await open();
    const claims = (doc: BrainDocument, ...quotes: string[]) => done(...quotes.map((q) => claimOf(doc.documentId, q)));
    await apply(capped, first, claims(first, Q1, Q2));
    await expectBrainError(apply(capped, second, claims(second, Q1, Q2)), "capacity");
    expect(await apply(capped, first, claims(first, Q1, Q2, Q3))).toEqual({ applied: true, written: 1, removed: 0 });
    expect(await states(second.documentId)).toEqual([]);
  });

  it("flags claims stale after a revision, refuses stale applies, re-queues and counts attempts per revision", async () => {
    const document = await publish("a");
    const run = await open();
    await apply(run, document, done(claimOf(document.documentId, Q1)));
    expect([await pending(), await pending(MODEL)]).toEqual([[], [document.documentId]]);
    const revised = await harness.repository.reviseDocument(scopeA,
      { documentId: document.documentId, expectedRevision: 1, body: `${BODY}\nMore.` });
    const [item] = (await harness.repository.listClaims(scopeA, {})).items;
    expect([item?.claim.stale, item?.claim.revision, item?.document.revision]).toEqual([true, 1, 2]);
    expect(await pending()).toEqual([document.documentId]);
    expect(await apply(run, document, done(claimOf(document.documentId, Q2)))).toEqual(STALE);
    expect(await apply(run, revised, done(), { incarnation: "00000000-0000-4000-8000-000000000000" })).toEqual(STALE);
    for (let n = 0; n < 2; n += 1) expect(await apply(run, revised, FAILED)).toEqual({ applied: true, written: 0, removed: 0 });
    expect(await states(document.documentId))
      .toEqual([{ extractor: RULES, status: "failed", attempts: 2, error_code: "extractor_error", revision: 2 }]);
    expect(await claimIds()).toHaveLength(1);
    expect([await pending(RULES, 2), await pending(RULES, 3)]).toEqual([[], [document.documentId]]);
    await apply(run, revised, { status: "skipped", errorCode: "document_too_large" });
    expect(await pending(RULES, 10)).toEqual([]);
  });

  it("removes claims and state with every tombstone path and runs with eraseScope", async () => {
    const { repository, db } = harness;
    const manual = await publish("manual");
    const { source } = await repository.createSource(scopeA, { kind: "git", externalRef: "repo", label: "Repo" });
    await repository.applySyncBatch(scopeA, { sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [],
      upserts: [brainContent("s1", { body: BODY }), brainContent("s2", { body: BODY })] });
    const run = await open();
    const synced = await Promise.all(["s1", "s2"].map(async (seed) =>
      (await repository.getDocument(scopeA, brainContent(seed).documentId))!));
    for (const document of [manual, ...synced]) await apply(run, document, done(claimOf(document.documentId, Q1)));
    await repository.deleteDocument(scopeA, { documentId: manual.documentId });
    expect(await apply(run, manual, done(claimOf(manual.documentId, Q1)))).toEqual(STALE);
    expect(await rowCounts()).toEqual([2, 2]);
    await repository.applySyncBatch(scopeA,
      { sourceId: source.sourceId, expectedCursor: "c1", nextCursor: "c2", upserts: [], deletions: [synced[0]!.documentId] });
    expect(await claimIds()).toEqual([claimOf(synced[1]!.documentId, Q1).claimId]);
    await repository.deleteSource(scopeA, { sourceId: source.sourceId, expectedRevision: 1 });
    expect(await rowCounts()).toEqual([0, 0]);
    expect(await countBrainRows(db, "brain_extraction_runs", scopeA)).toBe(1);
    await repository.eraseScope(scopeA);
    expect(await countBrainRows(db, "brain_extraction_runs", scopeA)).toBe(0);
  });

  it("fences writes by the running run, interrupts it after the lease and keeps fifty runs", async () => {
    const document = await publish("a");
    const run = await open();
    expect(run).toMatchObject({ status: "running", extractor: RULES, finishedAt: null, nextAction: "" });
    await expectBrainError(open(MODEL), "conflict");
    // The partial unique index stops a second running row that skips openExtractionRun (another process's race).
    await expect(harness.db.insertInto("brain_extraction_runs").values({ owner_id: scopeA.ownerId, scope_id: scopeA.scopeId,
      run_id: `xrn_${"1".repeat(32)}`, extractor: RULES, status: "running", error_code: null, started_at: harness.iso(),
      finished_at: null }).execute()).rejects.toThrow(/brain_extraction_runs_running/);
    await expectBrainError(apply(run, document, done(), { extractor: MODEL }), "conflict");
    harness.tick(5 * 60_000);
    const next = await open();
    await expectBrainError(apply(run, document, done()), "conflict");
    const closed = await harness.repository.closeExtractionRun(scopeA, { runId: next.runId, status: "partial", errorCode: null,
      counts: { ...ZERO_COUNTS, documentsProcessed: 2, documentsFailed: 1 }, usage: { ...NO_USAGE, costMicroUsd: 7 }, nextAction: "retry_later" });
    expect(closed).toMatchObject({ status: "partial", nextAction: "retry_later", finishedAt: harness.iso() });
    expect([closed.counts.documentsProcessed, closed.usage.costMicroUsd]).toEqual([2, 7]);
    await expectBrainError(close(next), "conflict");
    await expectBrainError(close({ ...next, runId: `xrn_${"0".repeat(32)}` }), "not_found");
    const statuses = await harness.db.selectFrom("brain_extraction_runs").select("status").orderBy("started_at").execute();
    expect(statuses.map((row) => row.status)).toEqual(["interrupted", "partial"]);
    for (let index = 0; index < 55; index += 1) {
      harness.tick();
      await close(await open());
    }
    // The billed run (cost 7) stays while it is inside the 30-day spend window.
    expect(await countBrainRows(harness.db, "brain_extraction_runs", scopeA)).toBe(51);
  });

  it("lists claims by kind and path with a keyset cursor and git footers only", async () => {
    const { repository } = harness;
    const { source } = await repository.createSource(scopeA, { kind: "git", externalRef: "repo", label: "Repo" });
    const docs = [{ seed: "pr", provenance: "git_pr", path: "src/a", at: "2026-10-01T10:00:00.000001Z" },
      { seed: "commit", provenance: "git_commit", path: "src/a/x.ts", at: "2026-10-01T10:00:00.000002Z" },
      { seed: "spec", provenance: "git_spec", path: "src/a-b/y.ts", at: "2026-10-01T10:00:00.000002Z" }];
    await repository.applySyncBatch(scopeA, { sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [],
      upserts: docs.map((doc) => ({ ...brainContent(doc.seed, { body: BODY, provenance: doc.provenance, sourceUpdatedAt: doc.at }),
        refs: [{ kind: "path", value: doc.path }] })) });
    const run = await open();
    const ids = docs.map((doc) => brainContent(doc.seed).documentId);
    for (const id of ids) {
      await apply(run, (await repository.getDocument(scopeA, id))!, done(claimOf(id, Q1), claimOf(id, Q3, { kind: "decision" })));
    }
    const all = await repository.listClaims(scopeA, { limit: 100 });
    const order = (ids[1]! > ids[2]! ? [1, 2, 0] : [2, 1, 0]).flatMap((index) => [ids[index], ids[index]]);
    expect(all.items.map((item) => item.document.documentId)).toEqual(order);
    expect(all.items.map((item) => item.claim.quote).slice(0, 2)).toEqual([Q1, Q3]);
    const walked: string[] = [];
    for (let cursor: string | null = null, first = true; first || cursor !== null; first = false) {
      const page = await repository.listClaims(scopeA, { limit: 1, cursor });
      walked.push(...page.items.map((item) => `${item.claim.documentId}:${item.claim.claimId}`));
      cursor = page.nextCursor;
    }
    expect(walked).toEqual(all.items.map((item) => `${item.claim.documentId}:${item.claim.claimId}`));
    const provenances = async (mode: "exact_or_under" | "under", kind?: BrainClaimKind) =>
      (await repository.listClaims(scopeA, { path: { value: "src/a", mode }, kind })).items.map((i) => i.document.provenance);
    expect(await provenances("exact_or_under")).toEqual(["git_commit", "git_commit", "git_pr", "git_pr"]);
    expect(await provenances("under", "decision")).toEqual(["git_commit"]);
    expect((await claimIds({ kind: "decision" }))).toHaveLength(3);
    const tails = Object.fromEntries(all.items.map((item) => [item.document.provenance, item.document.bodyTail]));
    expect(tails).toEqual({ git_pr: BODY, git_commit: BODY, git_spec: null });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const bad of ["!!", encode("x"), encode(["0000-01-01T00:00:00.000000Z", "a", 0, "b", RULES]), "e30"]) {
      await expectBrainError(repository.listClaims(scopeA, { cursor: bad }), "invalid");
    }
  });
});
