/**
 * Rules versions on PGlite: claims and state an older rules version stored (rules/v1) give way, document by document,
 * to the current version (BRAIN_RULES_EXTRACTOR_ID), never side by side; model claims are never touched.
 */
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRAIN_EXTRACTOR_ID_PATTERN, BRAIN_RULES_EXTRACTOR_ID, computeBrainClaimId, extractRulesClaims, runBrainExtraction,
  type BrainClaimInput, type BrainDocumentExtractionOutcome, type BrainExtractionOptions, type BrainExtractionRun,
} from "../../packages/gateway/src/brain/claims/index.js";
import type { BrainDocument } from "../../packages/gateway/src/brain/index.js";
import {
  brainDocumentId, countBrainRows, createBrainHarness, manualDocument, scopeA, type BrainHarness,
} from "./helpers/brain-store-helpers.js";

const V1 = "rules/v1";
const V2 = BRAIN_RULES_EXTRACTOR_ID;
const MODEL = "model:fake/p1";
const BODY = ["## Summary", "- Adds alpha.", "", "## Invariants", "- **Source of truth:** the brain_documents table.",
  "- **Lock/transaction scope:** one transaction per document."].join("\n");
const ZERO_COUNTS = { documentsProcessed: 0, documentsFailed: 0, claimsWritten: 0, claimsRemoved: 0, claimsRejected: 0,
  quotesRejected: 0 };

/** A claim on a quote of BODY. */
function claimOn(documentId: string, quote: string, kind: BrainClaimInput["kind"]): BrainClaimInput {
  const spanStart = BODY.indexOf(quote);
  return { claimId: computeBrainClaimId(documentId, kind, null, quote), kind, label: null, statement: quote, quote,
    spanStart, spanEnd: spanStart + quote.length, fields: {}, confidence: "high" };
}

describe("brain rules versions", { timeout: 60_000 }, () => {
  let h: BrainHarness;
  beforeEach(async () => { h = await createBrainHarness(); });
  afterEach(() => h.destroy());

  const seeds = (count: number) => Array.from({ length: count }, (_, n) => `d${n}`);
  const publish = async (seed: string, at: string) => (await h.repository.upsertDocument(scopeA,
    manualDocument(seed, { body: BODY, provenance: "git_commit", sourceUpdatedAt: at }))).document;
  const seed = (count: number) => Promise.all(seeds(count).map((name, n) => publish(name, `2026-09-0${n + 1}T00:00:00Z`)));
  const document = async (name: string) => (await h.repository.getDocument(scopeA, brainDocumentId(name)))!;
  const extract = (overrides: Partial<BrainExtractionOptions> = {}) => runBrainExtraction({
    repository: h.repository, scope: scopeA, extractor: { kind: "rules" }, now: () => h.now().getTime(), ...overrides,
  });
  const close = (run: BrainExtractionRun) => h.repository.closeExtractionRun(scopeA, {
    runId: run.runId, status: "succeeded", counts: ZERO_COUNTS, usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
    nextAction: "", errorCode: null,
  });
  /** One closed run of `extractor` that applies `outcome` to the document, as the job would. */
  const applyAs = async (extractor: string, doc: BrainDocument, outcome: BrainDocumentExtractionOutcome) => {
    const run = await h.repository.openExtractionRun(scopeA, { extractor });
    const result = await h.repository.applyDocumentExtraction(scopeA, { runId: run.runId, documentId: doc.documentId,
      incarnation: doc.incarnation, revision: doc.revision, extractor, outcome });
    await close(run);
    return result;
  };
  /** The current rules output for the document, so a test can store the same claims under another version. */
  const currentRules = (doc: BrainDocument) => extractRulesClaims(doc).claims;
  /** What rules/v1 stored: the current output plus a decision the current rules no longer make. */
  const v1Claims = (doc: BrainDocument) => [...currentRules(doc), claimOn(doc.documentId, "Adds alpha.", "decision")];
  const storeV1 = (doc: BrainDocument) => applyAs(V1, doc, { status: "done", claims: v1Claims(doc) });
  const pending = async (extractor = V2) => (await h.repository.listPendingExtractions(scopeA,
    { extractor, limit: 10, maxAttempts: 3 })).items.map((item) => item.documentId);
  const listed = async () => (await h.repository.listClaims(scopeA, { limit: 100 })).items.map((item) => item.claim);
  /** Stored rows, as [document seed, extractor] pairs per table, sorted. */
  const stored = async (table: "brain_claims" | "brain_extraction_state") => {
    const rows = await h.db.selectFrom(table).select(["document_id", "extractor"])
      .where("owner_id", "=", scopeA.ownerId).where("scope_id", "=", scopeA.scopeId).execute();
    const name = (id: string) => seeds(5).find((candidate) => brainDocumentId(candidate) === id);
    return rows.map((row) => `${name(row.document_id)} ${row.extractor}`).sort();
  };
  /** Rows an older gateway that has no version cleanup writes after the current version already ran. */
  const insertLegacyRows = async (doc: BrainDocument) => {
    const claim = claimOn(doc.documentId, "Adds alpha.", "decision");
    const row = { owner_id: scopeA.ownerId, scope_id: scopeA.scopeId, document_id: doc.documentId, extractor: V1,
      incarnation: doc.incarnation, revision: doc.revision };
    await h.db.insertInto("brain_claims").values({ ...row, claim_id: claim.claimId, kind: claim.kind, label: null,
      statement: claim.statement, quote: claim.quote, span_start: claim.spanStart, span_end: claim.spanEnd,
      fields: sql`'{}'::jsonb`, confidence: "high", created_at: h.iso() }).execute();
    await h.db.insertInto("brain_extraction_state").values({ ...row, status: "done", attempts: 1, error_code: null,
      updated_at: h.iso() }).execute();
  };

  it("names the current rules version rules/v2, a valid extractor id", () => {
    expect(V2).toBe("rules/v2");
    expect(BRAIN_EXTRACTOR_ID_PATTERN.test(V2)).toBe(true);
  });

  it("replaces every rules/v1 claim and state row with rules/v2 ones, counts both and stores no duplicate", async () => {
    const [d0, d1] = await seed(2);
    await storeV1(d0!);
    // d1's rules/v1 output equals the current one: same claim ids, still replaced row for row.
    await applyAs(V1, d1!, { status: "done", claims: currentRules(d1!) });
    const before = await listed();
    expect(before.map((claim) => claim.extractor)).toEqual(Array(5).fill(V1));
    expect([await pending(V1), await pending()]).toEqual([[], [d0!.documentId, d1!.documentId]]);

    const result = await extract();
    expect(result).toMatchObject({ status: "succeeded", extractor: V2, caughtUp: true, nextAction: "",
      counts: { documentsProcessed: 2, documentsFailed: 0, claimsWritten: 4, claimsRemoved: 5 },
      run: { extractor: V2, counts: { claimsWritten: 4, claimsRemoved: 5 } } });
    const after = await listed();
    expect(after.map((claim) => [claim.extractor, claim.kind, claim.label, claim.stale])).toEqual(Array(2).fill([
      [V2, "invariant", "Source of truth", false], [V2, "invariant", "Lock/transaction scope", false],
    ]).flat());
    expect(new Set(after.map((claim) => `${claim.documentId}:${claim.claimId}`)).size).toBe(4);
    // The id recipe never includes the extractor, so a claim read the same way keeps its id across versions.
    expect(after.map((claim) => claim.claimId).sort())
      .toEqual(before.filter((claim) => claim.kind === "invariant").map((claim) => claim.claimId).sort());
    expect(await stored("brain_claims")).toEqual(["d0 rules/v2", "d0 rules/v2", "d1 rules/v2", "d1 rules/v2"]);
    expect(await stored("brain_extraction_state")).toEqual(["d0 rules/v2", "d1 rules/v2"]);
    expect([await pending(), await pending(V1)]).toEqual([[], [d0!.documentId, d1!.documentId]]);
    expect(await extract()).toMatchObject({ caughtUp: true, counts: { documentsProcessed: 0, claimsRemoved: 0 } });
  });

  it("keeps rules/v1 claims readable until rules/v2 reaches their document, then hides and clears late ones", async () => {
    const docs = await seed(3);
    for (const doc of docs) await storeV1(doc);
    expect(await extract({ limits: { documentsPerRun: 1 } })).toMatchObject({ nextAction: "run_again", caughtUp: false,
      counts: { documentsProcessed: 1, claimsWritten: 2, claimsRemoved: 3 } });
    const byDocument = async () => {
      const claims = await listed();
      return seeds(3).map((name) => [...new Set(claims.filter((claim) => claim.documentId === brainDocumentId(name))
        .map((claim) => `${claim.extractor} x${claims.filter((c) => c.documentId === brainDocumentId(name)).length}`))]);
    };
    expect(await byDocument()).toEqual([[`${V2} x2`], [`${V1} x3`], [`${V1} x3`]]);
    expect(await pending()).toEqual([docs[1]!.documentId, docs[2]!.documentId]);
    expect(await stored("brain_extraction_state")).toEqual(["d0 rules/v2", "d1 rules/v1", "d2 rules/v1"]);

    // An older gateway still running writes d0 again: the read hides it, and the next rules run clears it.
    await insertLegacyRows(docs[0]!);
    expect(await byDocument()).toEqual([[`${V2} x2`], [`${V1} x3`], [`${V1} x3`]]);
    expect(await pending()).toEqual(docs.map((doc) => doc.documentId));
    expect(await extract()).toMatchObject({ caughtUp: true,
      counts: { documentsProcessed: 3, claimsWritten: 4, claimsRemoved: 7 } });
    expect(await stored("brain_claims")).toEqual(seeds(3).flatMap((name) => [`${name} ${V2}`, `${name} ${V2}`]));
    expect(await stored("brain_extraction_state")).toEqual(seeds(3).map((name) => `${name} ${V2}`));
  });

  it("never touches model claims or model state", async () => {
    const [d0] = await seed(1);
    await storeV1(d0!);
    const modelClaim = claimOn(d0!.documentId, "one transaction per document", "decision");
    expect(await applyAs(MODEL, d0!, { status: "done", claims: [modelClaim] }))
      .toEqual({ applied: true, written: 1, removed: 0 });
    const modelRows = () => h.db.selectFrom("brain_claims").selectAll().where("extractor", "=", MODEL).execute();
    const modelState = () => h.db.selectFrom("brain_extraction_state").selectAll().where("extractor", "=", MODEL).execute();
    const [claimsBefore, stateBefore] = [await modelRows(), await modelState()];
    h.tick();

    expect(await extract()).toMatchObject({ counts: { documentsProcessed: 1, claimsWritten: 2, claimsRemoved: 3 } });
    expect([await modelRows(), await modelState()]).toEqual([claimsBefore, stateBefore]);
    expect((await listed()).map((claim) => claim.extractor).sort()).toEqual([MODEL, V2, V2]);
    expect(await pending(MODEL)).toEqual([]);
    // A model write leaves the rules claims alone too.
    expect(await applyAs(MODEL, d0!, { status: "done", claims: [] })).toEqual({ applied: true, written: 0, removed: 1 });
    expect(await stored("brain_claims")).toEqual(["d0 rules/v2", "d0 rules/v2"]);
  });

  it("keeps the stale flag right across the upgrade and drops rules/v1 on any applied rules/v2 outcome", async () => {
    const [d0, d1] = await seed(2);
    await storeV1(d0!);
    await storeV1(d1!);
    const revise = (doc: BrainDocument, revision: number, body: string) => h.repository.reviseDocument(scopeA,
      { documentId: doc.documentId, expectedRevision: revision, body });
    const revised = await revise(d0!, 1, `${BODY}\nMore.`);
    const flags = async (doc: BrainDocument) => (await listed()).filter((claim) => claim.documentId === doc.documentId)
      .map((claim) => [claim.extractor, claim.revision, claim.stale]);
    expect(await flags(d0!)).toEqual(Array(3).fill([V1, 1, true]));

    // A rules/v2 outcome for a revision that is no longer live writes nothing and removes nothing.
    const run = await h.repository.openExtractionRun(scopeA, { extractor: V2 });
    const apply = (doc: BrainDocument, outcome: BrainDocumentExtractionOutcome) => h.repository.applyDocumentExtraction(
      scopeA, { runId: run.runId, documentId: doc.documentId, incarnation: doc.incarnation, revision: doc.revision,
        extractor: V2, outcome });
    expect(await apply(d0!, { status: "done", claims: currentRules(d0!) })).toEqual({ applied: false, reason: "stale" });
    expect(await flags(d0!)).toEqual(Array(3).fill([V1, 1, true]));
    expect(await apply(revised, { status: "done", claims: currentRules(revised) }))
      .toEqual({ applied: true, written: 2, removed: 3 });
    expect(await flags(d0!)).toEqual(Array(2).fill([V2, 2, false]));
    // A failed rules/v2 outcome also ends rules/v1 for its document; its own earlier claims stay and read stale.
    expect(await apply(d1!, { status: "failed", errorCode: "extractor_error" }))
      .toEqual({ applied: true, written: 0, removed: 3 });
    expect(await flags(d1!)).toEqual([]);
    const third = await revise(d0!, 2, `${BODY}\nMore still.`);
    expect(await apply(third, { status: "failed", errorCode: "extractor_error" }))
      .toEqual({ applied: true, written: 0, removed: 0 });
    expect(await flags(d0!)).toEqual(Array(2).fill([V2, 2, true]));
    expect(await stored("brain_extraction_state")).toEqual(["d0 rules/v2", "d1 rules/v2"]);
    await close(run);
  });

  it("does not need room for two rules versions under the scope's claim cap", async () => {
    await h.destroy();
    h = await createBrainHarness({ maxClaimsPerScope: 2 });
    const [d0] = await seed(1);
    await applyAs(V1, d0!, { status: "done", claims: currentRules(d0!) });
    expect(await extract()).toMatchObject({ status: "succeeded", errorCode: null,
      counts: { documentsProcessed: 1, claimsWritten: 2, claimsRemoved: 2 } });
    expect(await countBrainRows(h.db, "brain_claims", scopeA)).toBe(2);
  });
});
