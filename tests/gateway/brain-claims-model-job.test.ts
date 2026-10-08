/**
 * runBrainExtraction with a model on PGlite: newest-first selection, skipped and invalid outcomes, BrainModelError
 * codes, the cost cap, cache counts on runs, and abort and timeout through the Claude client over a fake fetch.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  BRAIN_MODEL_DEFAULT_EXTRACTOR_ID, BRAIN_MODEL_PROMPT_VERSION, BRAIN_RULES_EXTRACTOR_ID, BrainModelError,
  runBrainExtraction,
  type BrainClaimModel, type BrainExtractionOptions, type BrainExtractionStore, type BrainModelErrorCode,
} from "../../packages/gateway/src/brain/claims/index.js";
import { createBrainClaimModelProvider } from "../../packages/gateway/src/brain/claims/model/config.js";
import { brainModelCallWorstCostMicroUsd } from "../../packages/gateway/src/brain/claims/spend.js";
import { brainDocumentId, createBrainHarness, manualDocument, scopeA, type BrainHarness } from "./helpers/brain-store-helpers.js";
import { fakeAnthropic, jsonResponse, messageBody, SYNTHETIC_KEY } from "./helpers/brain-model-fetch.js";

const MODEL = { kind: "model", modelId: "claude-opus-5-5", promptVersion: BRAIN_MODEL_PROMPT_VERSION } as const;
const USAGE = { inputTokens: 100, outputTokens: 10, costMicroUsd: 5, cacheReadTokens: 40, cacheWriteTokens: 20 };
const SEEDS = ["d0", "d1", "d2"];
const body = (n: number) => [`## Decisions for document ${n}`, "- **Storage:** keep one transaction per document so a crash "
  + "never leaves half of a document's claims behind.", "- **Order:** the newest documents are read first because "
  + "they describe the system as it is today."].join("\n");
const CLAIM = { kind: "decision", label: null, statement: "keep one transaction per document",
  quote: "**Storage:** keep one transaction per document so a crash never leaves half of a document's claims behind." };

const fakeModel = (extract: (input: { body: string }) => Promise<unknown>): BrainClaimModel =>
  ({ extract: vi.fn(extract) as unknown as BrainClaimModel["extract"] });
const returning = (output: object) => fakeModel(async () => ({ claims: [], usage: USAGE, ...output }));
const failingWith = (code: BrainModelErrorCode) => fakeModel(async () => { throw new BrainModelError(code); });

describe("brain claim extraction with a model", { timeout: 60_000 }, () => {
  let h: BrainHarness;
  let warn: MockInstance<typeof console.warn>;
  const homes: string[] = [];
  beforeEach(async () => { h = await createBrainHarness(); warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(async () => {
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    await h.destroy();
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
    expect(logged).not.toContain(SYNTHETIC_KEY);
  });

  const extract = (overrides: Partial<BrainExtractionOptions> = {}) => runBrainExtraction({
    repository: h.repository, scope: scopeA, extractor: MODEL, now: () => h.now().getTime(), ...overrides,
  });
  const seed = async (count: number) => { for (let n = 0; n < count; n += 1) await h.repository.upsertDocument(scopeA,
    manualDocument(SEEDS[n]!, { body: body(n), provenance: "git_commit", sourceUpdatedAt: `2026-09-0${n + 1}T00:00:00Z` })); };
  /** State rows of one extractor by seed: [status, error code, attempts]. */
  const states = async (extractor = BRAIN_MODEL_DEFAULT_EXTRACTOR_ID) => Object.fromEntries((await h.db
    .selectFrom("brain_extraction_state").select(["document_id", "status", "error_code", "attempts"])
    .where("scope_id", "=", scopeA.scopeId).where("extractor", "=", extractor).execute())
    .map((row) => [SEEDS.find((seed) => brainDocumentId(seed) === row.document_id), [row.status, row.error_code, row.attempts]]));

  it("reads the newest pending documents first for a model and keeps rules runs oldest first", async () => {
    await seed(3);
    const seen: string[] = [];
    const model = fakeModel(async (input) => { seen.push(input.body); return { claims: [], usage: USAGE }; });
    expect(await extract({ model, limits: { documentsPerRun: 2 } }))
      .toMatchObject({ status: "succeeded", nextAction: "run_again", counts: { documentsProcessed: 2 } });
    expect(seen).toEqual([body(2), body(1)]);
    expect(await states()).toEqual({ d2: ["done", null, 1], d1: ["done", null, 1] });
    expect(await extract({ extractor: { kind: "rules" }, limits: { documentsPerRun: 1 } }))
      .toMatchObject({ counts: { documentsProcessed: 1 } });
    expect(Object.keys(await states(BRAIN_RULES_EXTRACTOR_ID))).toEqual(["d0"]);
  });

  it.each([
    ["a refusal", { status: "skipped", code: "model_refused" }, ["skipped", "model_refused", 1]],
    ["a short body", { status: "skipped", code: "body_too_short" }, ["skipped", "body_too_short", 1]],
    ["a squash list", { status: "skipped", code: "commit_list_only" }, ["skipped", "commit_list_only", 1]],
    ["invalid output", { status: "invalid" }, ["failed", "model_output_invalid", 1]],
    ["an unknown outcome", { status: "bogus" }, ["failed", "model_output_invalid", 1]],
  ])("records %s with its usage and ignores its claims", async (_label, outcome, state) => {
    await seed(1);
    const model = returning({ claims: [CLAIM], outcome });
    const failed = state[0] === "failed" ? 1 : 0;
    expect(await extract({ model })).toMatchObject({
      status: failed ? "partial" : "succeeded", usage: USAGE,
      counts: { documentsProcessed: 1, documentsFailed: failed, claimsWritten: 0 },
    });
    expect(await states()).toEqual({ d0: state });
    // A skipped revision stays skipped until it is revised; a failed one is retried.
    expect((await extract({ model })).counts.documentsProcessed).toBe(failed);
    if (failed) return;
    await h.repository.reviseDocument(scopeA, { documentId: brainDocumentId("d0"), expectedRevision: 1, body: body(9) });
    expect((await extract({ model })).counts.documentsProcessed).toBe(1);
  });

  it("sends only the provenances it is given, even when the store returns others", async () => {
    await seed(2);
    const model = returning({});
    expect(await extract({ model, provenances: ["git_pr", "git_spec"] }))
      .toMatchObject({ status: "succeeded", caughtUp: true, counts: { documentsProcessed: 0 } });
    expect(await extract({ model, provenances: ["Not a kind"] })).toMatchObject({ errorCode: "invalid_options" });
    const r = h.repository;
    const unfiltered: BrainExtractionStore = {
      getDocument: r.getDocument.bind(r), openExtractionRun: r.openExtractionRun.bind(r),
      applyDocumentExtraction: r.applyDocumentExtraction.bind(r), closeExtractionRun: r.closeExtractionRun.bind(r),
      listPendingExtractions: (scope, { provenances: _ignored, ...query }) => r.listPendingExtractions(scope, query),
    };
    expect(await extract({ repository: unfiltered, model, provenances: ["git_pr"] }))
      .toMatchObject({ status: "succeeded", counts: { documentsProcessed: 2, documentsFailed: 0 } });
    expect(model.extract).not.toHaveBeenCalled();
    expect(await states()).toEqual({ d1: ["skipped", "provenance_not_allowed", 1], d0: ["skipped", "provenance_not_allowed", 1] });
  });

  it("never sends a provenance outside the git allow-list, whatever the caller or the store passes", async () => {
    await h.repository.upsertDocument(scopeA, manualDocument("d0", { body: body(0), provenance: "matrix_note" }));
    await h.repository.upsertDocument(scopeA, manualDocument("d1", { body: body(1), provenance: "manual" }));
    const model = returning({});
    // No provenances: only the git ones are listed, so the note and the manual document stay pending.
    expect(await extract({ model })).toMatchObject({ status: "succeeded", caughtUp: true, counts: { documentsProcessed: 0 } });
    // Asked for the note by name: nothing is sendable, no run reads a document.
    expect(await extract({ model, provenances: ["matrix_note", "manual"] }))
      .toMatchObject({ status: "succeeded", caughtUp: true, counts: { documentsProcessed: 0 } });
    expect(await states()).toEqual({});
    const r = h.repository;
    const unfiltered: BrainExtractionStore = {
      getDocument: r.getDocument.bind(r), openExtractionRun: r.openExtractionRun.bind(r),
      applyDocumentExtraction: r.applyDocumentExtraction.bind(r), closeExtractionRun: r.closeExtractionRun.bind(r),
      listPendingExtractions: (scope, { provenances: _ignored, ...query }) => r.listPendingExtractions(scope, query),
    };
    // A store that ignores the filter is still never trusted with what leaves the gateway.
    for (const provenances of [undefined, ["matrix_note"], ["git_pr", "matrix_note"]]) {
      await extract({ repository: unfiltered, model, ...(provenances ? { provenances } : {}) });
    }
    expect(model.extract).not.toHaveBeenCalled();
    expect(await states()).toEqual({ d1: ["skipped", "provenance_not_allowed", 1], d0: ["skipped", "provenance_not_allowed", 1] });
    // Rules runs read every provenance.
    expect((await extract({ extractor: { kind: "rules" } })).counts.documentsProcessed).toBe(2);
  });

  it("writes the verified claims of an output without an outcome", async () => {
    await seed(1);
    expect(await extract({ model: returning({ claims: [CLAIM] }) }))
      .toMatchObject({ status: "succeeded", extractor: BRAIN_MODEL_DEFAULT_EXTRACTOR_ID, counts: { claimsWritten: 1 } });
  });

  it.each([
    ["model_auth_failed", "configure_model"], ["model_unavailable", "retry_later"],
  ] as const)("stops the run on %s without touching a document", async (code, nextAction) => {
    await seed(2);
    const model = failingWith(code);
    expect(await extract({ model })).toMatchObject({
      status: "failed", errorCode: code, nextAction, caughtUp: false, counts: { documentsProcessed: 0 },
      run: { status: "failed", errorCode: code, nextAction },
    });
    expect(model.extract).toHaveBeenCalledTimes(1);
    expect(await states()).toEqual({});
  });

  it("fails the newest document on model_rejected then stops; model_timeout fails only its document", async () => {
    await seed(3);
    const rejecting = failingWith("model_rejected");
    expect(await extract({ model: rejecting })).toMatchObject({
      status: "failed", errorCode: "model_rejected", nextAction: "contact_support",
      counts: { documentsProcessed: 1, documentsFailed: 1 }, run: { status: "failed", errorCode: "model_rejected" },
    });
    expect(rejecting.extract).toHaveBeenCalledTimes(1);
    expect(await states()).toEqual({ d2: ["failed", "model_failed", 1] });
    let calls = 0;
    const timing = fakeModel(async () => {
      calls += 1;
      if (calls === 1) throw new BrainModelError("model_timeout");
      return { claims: [], usage: USAGE };
    });
    // A timed-out call is charged at its worst case (it may still be billed), so roomy budgets let the run go on.
    const roomy = { costMicroUsdPerRun: 50_000_000, spendMicroUsdPer30d: 50_000_000 };
    const timed = await extract({ model: timing, limits: roomy });
    expect(timed)
      .toMatchObject({ status: "partial", nextAction: "retry_later", counts: { documentsProcessed: 3, documentsFailed: 1 } });
    const worst = brainModelCallWorstCostMicroUsd(Buffer.byteLength(`Title d2${body(2)}`, "utf8"));
    expect(timed.usage.costMicroUsd).toBe(worst + 2 * USAGE.costMicroUsd);
    expect(await states()).toEqual({ d2: ["failed", "model_timeout", 2], d1: ["done", null, 1], d0: ["done", null, 1] });
  });

  it("takes a model's free skips before the spend cap, so a budget too small for a call never holds them up", async () => {
    await seed(2);
    const model: BrainClaimModel = {
      skip: vi.fn((input: { body: string }) => input.body === body(1) ? "document_too_large" : "bogus") as never,
      extract: vi.fn(async () => ({ claims: [], usage: USAGE })),
    };
    expect(await extract({ model, limits: { spendMicroUsdPer30d: 1 } })).toMatchObject({
      status: "failed", errorCode: "spend_cap_reached", nextAction: "raise_budget",
      counts: { documentsProcessed: 1 }, usage: { costMicroUsd: 0 },
    });
    // An unknown skip code is not trusted: that document goes on to the spend cap, which stops the run.
    expect(model.skip).toHaveBeenCalledTimes(2);
    expect(model.extract).not.toHaveBeenCalled();
    expect(await states()).toEqual({ d1: ["skipped", "document_too_large", 1] });
  });

  it("stops before a call once the cost cap is reached and records cache counts on the run row", async () => {
    await seed(3);
    const model = returning({ usage: { ...USAGE, costMicroUsd: 300_000 } });
    const result = await extract({ model, limits: { costMicroUsdPerRun: 500_000 } });
    expect(model.extract).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "succeeded", nextAction: "run_again", caughtUp: false, counts: { documentsProcessed: 2 } });
    const usage = { inputTokens: 200, outputTokens: 20, costMicroUsd: 600_000, cacheReadTokens: 80, cacheWriteTokens: 40 };
    expect([result.usage, result.run?.usage]).toEqual([usage, usage]);
    expect(await h.db.selectFrom("brain_extraction_runs").select(["cache_read_tokens", "cache_write_tokens"])
      .where("run_id", "=", result.run!.runId).executeTakeFirstOrThrow()).toEqual({ cache_read_tokens: 80, cache_write_tokens: 40 });
    // A model that reports no cache counts adds zeros.
    const { cacheReadTokens: _r, cacheWriteTokens: _w, ...plain } = USAGE;
    expect((await extract({ model: returning({ usage: plain }) })).usage)
      .toEqual({ ...plain, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("adds the cache columns back to a runs table created without them", async () => {
    await sql`ALTER TABLE brain_extraction_runs DROP COLUMN cache_read_tokens, DROP COLUMN cache_write_tokens`.execute(h.db);
    await h.repository.bootstrap();
    await h.repository.bootstrap();
    await seed(1);
    expect((await extract({ model: returning({}) })).run?.usage).toEqual(USAGE);
  });

  describe("through the Claude client", () => {
    const resolve = async (fetch: ReturnType<typeof fakeAnthropic>["fetch"]) => {
      const home = await mkdtemp(join(tmpdir(), "brain-model-job-"));
      homes.push(home);
      const resolved = await createBrainClaimModelProvider({ homePath: home, env: { ANTHROPIC_API_KEY: SYNTHETIC_KEY }, fetch })();
      if (resolved === null) throw new Error("expected a configured model");
      const { model, modelId, promptVersion, limits } = resolved;
      return (overrides: Partial<BrainExtractionOptions> = {}) =>
        extract({ extractor: { kind: "model", modelId, promptVersion }, model, ...overrides, limits: { ...limits, ...overrides.limits } });
    };

    it("leaves the document untouched when the run is aborted mid-call", async () => {
      await seed(1);
      const controller = new AbortController();
      const fake = fakeAnthropic(() => { setTimeout(() => controller.abort(), 10); return "hang"; });
      const run = await resolve(fake.fetch);
      expect(await run({ signal: controller.signal }))
        .toMatchObject({ status: "succeeded", nextAction: "run_again", caughtUp: false, counts: { documentsProcessed: 0 } });
      expect(fake.requests).toHaveLength(1);
      expect(await states()).toEqual({});
    });

    it("skips an oversized or short body without a call even when the budget left covers no call", async () => {
      const add = (seed: string, docBody: string, day: number) => h.repository.upsertDocument(scopeA, manualDocument(seed,
        { body: docBody, provenance: "git_pr", sourceUpdatedAt: `2026-09-0${day}T00:00:00Z` }));
      await add("d0", body(0), 1);
      await add("d1", `${body(1)}\n${"- More detail on the storage choice.\n".repeat(1_200)}`, 2);
      await add("d2", "Short body.", 3);
      const fake = fakeAnthropic(() => jsonResponse(200, messageBody()));
      const run = await resolve(fake.fetch);
      // Newest first: the two free skips are recorded, then the sendable document stops the run on the cap.
      expect(await run({ limits: { spendMicroUsdPer30d: 1 } })).toMatchObject({
        status: "failed", errorCode: "spend_cap_reached", counts: { documentsProcessed: 2 }, usage: { costMicroUsd: 0 },
      });
      expect(fake.requests).toHaveLength(0);
      expect(await states()).toEqual({ d2: ["skipped", "body_too_short", 1], d1: ["skipped", "document_too_large", 1] });
    });

    it("fails the document as model_timeout when the call outlives the per-call timeout", async () => {
      await seed(1);
      const fake = fakeAnthropic(() => "hang");
      const run = await resolve(fake.fetch);
      expect(await run({ limits: { modelCallTimeoutMs: 50 } }))
        .toMatchObject({ status: "partial", nextAction: "retry_later", counts: { documentsFailed: 1 } });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]!.signal?.aborted).toBe(true);
      expect(await states()).toEqual({ d0: ["failed", "model_timeout", 1] });
    });
  });
});
