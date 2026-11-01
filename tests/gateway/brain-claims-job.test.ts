/** runBrainExtraction on a PGlite BrainRepository: rules, bounds, the guard, fake models only, store failures. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  BRAIN_RULES_EXTRACTOR_ID as RULES, runBrainExtraction, type BrainClaimModel, type BrainClaimModelOutput,
  type BrainExtractionOptions, type BrainExtractionStore,
} from "../../packages/gateway/src/brain/claims/index.js";
import { brainModelCallWorstCostMicroUsd } from "../../packages/gateway/src/brain/claims/spend.js";
import { BrainStoreError } from "../../packages/gateway/src/brain/index.js";
import { brainDocumentId, createBrainHarness, manualDocument, scopeA, scopeB, type BrainHarness } from "./helpers/brain-store-helpers.js";

const BODY = ["## Summary", "- Adds alpha.", "", "## Invariants", "- **Source of truth:** the brain_documents table.",
  "- **Lock/transaction scope:** one transaction per document."].join("\n");
const MODEL = { kind: "model", modelId: "fake", promptVersion: "p1" } as const;
const USAGE = { inputTokens: 10, outputTokens: 5, costMicroUsd: 3 };

const fakeModel = (extract: (input: { body: string }) => Promise<unknown>): BrainClaimModel =>
  ({ extract: vi.fn(extract) as unknown as BrainClaimModel["extract"] });
const hung = () => fakeModel(() => new Promise(() => undefined));
const boom = async () => { throw new Error("postgres down at /home/matrix"); };
const STORE_METHODS = ["getDocument", "listPendingExtractions", "openExtractionRun", "applyDocumentExtraction",
  "closeExtractionRun"] as const;

describe("brain claim extraction job", { timeout: 60_000 }, () => {
  let h: BrainHarness;
  let warn: MockInstance<typeof console.warn>;
  beforeEach(async () => { h = await createBrainHarness(); warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(async () => { warn.mockRestore(); await h.destroy(); });

  const extract = (overrides: Partial<BrainExtractionOptions> = {}) => runBrainExtraction({
    repository: h.repository, scope: scopeA, extractor: { kind: "rules" }, now: () => h.now().getTime(), ...overrides,
  });
  /** The real repository with some methods replaced. */
  const storeWith = (overrides: Partial<BrainExtractionStore>) => Object.fromEntries(STORE_METHODS.map((name) =>
    [name, overrides[name] ?? h.repository[name].bind(h.repository)])) as unknown as BrainExtractionStore;
  const seed = async (count: number) => { for (let n = 0; n < count; n += 1) await h.repository.upsertDocument(scopeA,
    manualDocument(`d${n}`, { body: BODY, provenance: "git_commit", sourceUpdatedAt: `2026-09-0${n + 1}T00:00:00Z` })); };
  const revise = (seed: string, body: string) =>
    h.repository.reviseDocument(scopeA, { documentId: brainDocumentId(seed), expectedRevision: 1, body });
  const states = () => h.db.selectFrom("brain_extraction_state").select(["status", "attempts", "error_code"])
    .where("scope_id", "=", scopeA.scopeId).orderBy("document_id").execute();
  const claims = async () => (await h.repository.listClaims(scopeA, { limit: 100 })).items.map((item) => item.claim);

  it("extracts rules claims once per scope at a time, is then caught up, and replaces claims after a revision", async () => {
    await seed(1);
    const [first, second, other] = await Promise.all([extract(), extract(), extract({ scope: scopeB })]);
    expect(first).toMatchObject({
      status: "succeeded", errorCode: null, nextAction: "", extractor: RULES, caughtUp: true,
      counts: { documentsProcessed: 1, documentsFailed: 0, claimsWritten: 2, claimsRemoved: 0 },
      run: { status: "succeeded", extractor: RULES, counts: { claimsWritten: 2 } },
    });
    expect([second.errorCode, second.run, second.nextAction, other.errorCode]).toEqual(["extraction_in_progress", null, "retry_later", null]);
    expect((await claims()).map((claim) => [claim.kind, claim.label, claim.stale]).sort())
      .toEqual([["invariant", "Lock/transaction scope", false], ["invariant", "Source of truth", false]]);
    expect(await extract()).toMatchObject({ status: "succeeded", caughtUp: true, counts: { documentsProcessed: 0 } });
    await revise("d0", BODY.replace("brain_documents", "brain_claims"));
    expect((await claims()).every((claim) => claim.stale)).toBe(true);
    expect(await extract()).toMatchObject({ counts: { documentsProcessed: 1, claimsWritten: 1, claimsRemoved: 1 } });
    expect((await claims()).map((claim) => [claim.revision, claim.stale])).toEqual([[2, false], [2, false]]);
    // Another process's running run.
    await h.repository.openExtractionRun(scopeA, { extractor: RULES });
    expect(await extract()).toMatchObject({ status: "failed", errorCode: "extraction_in_progress", run: null });
  });

  it("bounds a run by documents, body bytes, wall time and the caller's signal", async () => {
    await seed(3);
    const results = [];
    for (let run = 0; run < 3; run += 1) results.push(await extract({ limits: { documentsPerRun: 1 } }));
    expect(results.map((r) => [r.counts.documentsProcessed, r.nextAction, r.caughtUp]))
      .toEqual([[1, "run_again", false], [1, "run_again", false], [1, "", true]]);
    for (const [seed, body] of [["d0", "x"], ["d1", "y"]] as const) await revise(seed, body);
    expect(await extract({ limits: { bodyBytesPerRun: 1 } }))
      .toMatchObject({ status: "succeeded", nextAction: "run_again", counts: { documentsProcessed: 1 } });
    let clock = 0;
    expect(await extract({ now: () => (clock += 5_000), limits: { runBudgetMs: 1_000 } }))
      .toMatchObject({ nextAction: "run_again", counts: { documentsProcessed: 0 } });
    expect(await extract({ signal: AbortSignal.abort() }))
      .toMatchObject({ status: "succeeded", nextAction: "run_again", caughtUp: false, counts: { documentsProcessed: 0 } });
  });

  it.each([
    ["zero limit", { limits: { documentsPerRun: 0 } }], ["unknown limit", { limits: { bogus: 1 } }],
    ["empty owner", { scope: { ownerId: "", scopeId: "s" } }], ["unknown extractor", { extractor: { kind: "x" } }],
    ["bad model id", { extractor: { ...MODEL, modelId: "bad id" } }], ["no kinds", { extractor: { ...MODEL, kinds: [] } }],
    ["repeated kinds", { extractor: { ...MODEL, kinds: ["risk", "risk"] } }],
  ])("returns invalid_options for %s without a run", async (_label, overrides) => {
    expect(await extract(overrides as Partial<BrainExtractionOptions>))
      .toMatchObject({ status: "failed", errorCode: "invalid_options", nextAction: "contact_support", extractor: "", run: null });
  });

  it("stores verified model claims and counts hallucinated quotes; no model is model_not_configured", async () => {
    await seed(1);
    const model = fakeModel(async (): Promise<BrainClaimModelOutput> => ({ usage: USAGE, claims: [
      { kind: "decision", statement: "One transaction per document", quote: "one   transaction per document" },
      { kind: "risk", statement: "Invented", quote: "this text is not in the document" },
    ] }));
    expect(await extract({ extractor: { ...MODEL, kinds: ["decision", "risk"] }, model })).toMatchObject({
      status: "succeeded", extractor: "model:fake/p1", usage: USAGE, counts: { documentsProcessed: 1, claimsWritten: 1, quotesRejected: 1 },
    });
    expect((await claims()).map((c) => [c.extractor, c.kind, c.quote]))
      .toEqual([["model:fake/p1", "decision", "one transaction per document"]]);
    expect(await extract({ extractor: MODEL }))
      .toMatchObject({ errorCode: "model_not_configured", nextAction: "configure_model", extractor: "model:fake/p1", run: null });
  });

  it("records model failures per document, retries them up to maxAttempts, and times out a hung call", async () => {
    await seed(1);
    const failing = fakeModel(() => Promise.reject(`secret ${BODY}`));
    const limits = { maxAttempts: 2 };
    expect(await extract({ extractor: MODEL, model: failing, limits }))
      .toMatchObject({ status: "partial", nextAction: "retry_later", counts: { documentsFailed: 1 } });
    await extract({ extractor: MODEL, model: failing, limits });
    expect(await states()).toEqual([{ status: "failed", attempts: 2, error_code: "model_failed" }]);
    expect(await extract({ extractor: MODEL, model: failing, limits }))
      .toMatchObject({ status: "succeeded", caughtUp: true, counts: { documentsProcessed: 0 } });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(await extract({ extractor: MODEL, model: hung(), limits: { maxAttempts: 3, modelCallTimeoutMs: 20 } }))
      .toMatchObject({ status: "partial", counts: { documentsFailed: 1 } });
    expect(await states()).toEqual([{ status: "failed", attempts: 3, error_code: "model_timeout" }]);
    // A synchronous throw must not leave the timeout's rejection unhandled (vitest fails the run on one).
    const throwing = { extract: () => { throw new Error("sync"); } } as unknown as BrainClaimModel;
    await extract({ extractor: MODEL, model: throwing, limits: { maxAttempts: 4, modelCallTimeoutMs: 20 } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await states()).toEqual([{ status: "failed", attempts: 4, error_code: "model_failed" }]);
  });

  it("stops at the token and cost budgets and fails the run closed on invalid usage, charged at worst case", async () => {
    await seed(3);
    const model = fakeModel(async () => ({ usage: USAGE, claims: [] }));
    expect(await extract({ extractor: MODEL, model, limits: { tokensPerRun: 15 } }))
      .toMatchObject({ nextAction: "run_again", usage: USAGE, counts: { documentsProcessed: 1 } });
    expect(await extract({ extractor: MODEL, model, limits: { costMicroUsdPerRun: 3 } }))
      .toMatchObject({ nextAction: "run_again", counts: { documentsProcessed: 1 } });
    // The call may still be billed, so its worst case is saved on the run and counted by the next spend check.
    const worst = brainModelCallWorstCostMicroUsd(Buffer.byteLength(`Title d0${BODY}`, "utf8"));
    const before = (await h.repository.readModelSpend(scopeA)).costMicroUsd;
    for (const output of [{ usage: { ...USAGE, inputTokens: -1 }, claims: [] }, null]) {
      expect(await extract({ extractor: MODEL, model: fakeModel(async () => output) })).toMatchObject({
        status: "failed", errorCode: "model_usage_invalid", nextAction: "contact_support",
        usage: { costMicroUsd: worst }, counts: { documentsProcessed: 0 },
        run: { status: "failed", errorCode: "model_usage_invalid", usage: { costMicroUsd: worst } },
      });
    }
    expect((await h.repository.readModelSpend(scopeA)).costMicroUsd).toBe(before + 2 * worst);
    // This cap would still cover one more call had those charges been dropped.
    const unused = fakeModel(async () => ({ usage: USAGE, claims: [] }));
    expect(await extract({ extractor: MODEL, model: unused, limits: { spendMicroUsdPer30d: before + worst } }))
      .toMatchObject({ status: "failed", errorCode: "spend_cap_reached", counts: { documentsProcessed: 0 } });
    expect(unused.extract).not.toHaveBeenCalled();
  });

  it("stops on an abort during a model call, skips empty bodies and records malformed output", async () => {
    await seed(1);
    const controller = new AbortController();
    const aborting = storeWith({ getDocument: (scope, id) => (controller.abort(), h.repository.getDocument(scope, id)) });
    expect(await extract({ extractor: MODEL, model: hung(), repository: aborting, signal: controller.signal }))
      .toMatchObject({ status: "succeeded", nextAction: "run_again", counts: { documentsProcessed: 0 } });
    expect(await states()).toEqual([]);
    const malformed = fakeModel(async () => ({ usage: USAGE, claims: "not a list" }));
    expect(await extract({ extractor: MODEL, model: malformed })).toMatchObject({ counts: { documentsFailed: 1 } });
    expect(await states()).toEqual([{ status: "failed", attempts: 1, error_code: "model_output_invalid" }]);
    await revise("d0", " ");
    const unused = fakeModel(async () => ({ usage: USAGE, claims: [] }));
    expect(await extract({ extractor: MODEL, model: unused })).toMatchObject({ counts: { documentsProcessed: 1 } });
    expect(unused.extract).not.toHaveBeenCalled();
  });

  it("leaves documents that moved since the listing pending, skips vanished ones and records an extractor bug", async () => {
    await seed(3);
    const [gone, broken] = ["d0", "d2"].map(brainDocumentId);
    const racing = storeWith({
      // d1 is revised after the listing, before it is read.
      listPendingExtractions: async (scope, query) => {
        const page = await h.repository.listPendingExtractions(scope, query);
        return revise("d1", "moved").then(() => page);
      },
      getDocument: async (scope, id) => {
        const document = await h.repository.getDocument(scope, id);
        return id === gone ? null : id === broken ? { ...document!, body: undefined as unknown as string } : document;
      },
    });
    expect(await extract({ repository: racing }))
      .toMatchObject({ status: "partial", nextAction: "run_again", caughtUp: false, counts: { documentsProcessed: 1, documentsFailed: 1 } });
    expect(await states()).toEqual([{ status: "failed", attempts: 1, error_code: "extractor_error" }]);
  });

  it("maps scope capacity and refused claims to their codes", async () => {
    const capped = await createBrainHarness({ maxClaimsPerScope: 1 });
    await capped.repository.upsertDocument(scopeA, manualDocument("d0", { body: BODY }));
    expect(await runBrainExtraction({ repository: capped.repository, scope: scopeA, extractor: { kind: "rules" } }))
      .toMatchObject({ status: "failed", errorCode: "claims_capacity", nextAction: "raise_capacity" });
    await capped.destroy();
    await seed(1);
    // The store's refusal, then Postgres refusing a value (class 22): the document fails and the run goes on.
    for (const refusal of [new BrainStoreError("invalid"), Object.assign(new Error("bad"), { code: "22P05" })]) {
      const refusing = storeWith({ applyDocumentExtraction: async (scope, input) => {
        if (input.outcome.status === "done") throw refusal;
        return h.repository.applyDocumentExtraction(scope, input);
      } });
      expect(await extract({ repository: refusing, limits: { maxAttempts: 2 } }))
        .toMatchObject({ status: "partial", counts: { documentsFailed: 1 } });
    }
    expect(await states()).toEqual([{ status: "failed", attempts: 2, error_code: "claim_invalid" }]);
  });

  it("maps every store failure to a run code and never rejects", async () => {
    await seed(1);
    const refuse = (code: "invalid" | "conflict") => async () => { throw new BrainStoreError(code); };
    const cases: [Partial<BrainExtractionStore>, object][] = [
      [{ openExtractionRun: boom }, { errorCode: "store_unavailable", nextAction: "retry_later", run: null }],
      [{ getDocument: boom }, { errorCode: "store_unavailable", run: { status: "failed" } }],
      [{ applyDocumentExtraction: boom }, { errorCode: "store_unavailable", run: { errorCode: "store_unavailable" } }],
      [{ applyDocumentExtraction: refuse("invalid") }, { errorCode: "store_unavailable" }],
      [{ applyDocumentExtraction: refuse("conflict") }, { errorCode: "run_superseded", run: { status: "failed" } }],
      [{ applyDocumentExtraction: async () => ({ applied: false, reason: "stale" }) }, { nextAction: "run_again" }],
      [{ now: () => { throw new Error("clock"); } } as object, { errorCode: "internal_error", run: { status: "failed" } }],
      // Last: a run whose close fails stays running until its lease expires.
      [{ listPendingExtractions: boom, closeExtractionRun: boom }, { errorCode: "store_unavailable", run: null }],
    ];
    for (const [overrides, expected] of cases) {
      const { now, ...store } = overrides as Partial<BrainExtractionStore> & { now?: () => number };
      expect(await extract({ repository: storeWith(store), ...now ? { now } : {} })).toMatchObject(expected);
    }
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/postgres|\/home\//);
  });
});
