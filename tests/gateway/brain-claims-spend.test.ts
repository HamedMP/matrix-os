/**
 * The model spend cap across runs (claims/spend.ts and its hooks in job.ts, store.ts, repository.ts and
 * model/config.ts): the worst case of one call against the real pricing, the 30-day window, the stop before a call
 * the budget cannot cover, the cost saved as a run goes (so a run that never closes still counts), the prune that
 * keeps billed runs, and runs that overlap in one scope or run in two. Fake models only; no network.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  BRAIN_EXTRACTION_DEFAULT_LIMITS, BRAIN_EXTRACTION_RUN_LEASE_MS, BRAIN_MODEL_MAX_RETRIES, BRAIN_MODEL_MAX_TOKENS,
  BRAIN_MODEL_SPEND_BILLED_RUNS_MAX, BRAIN_MODEL_SPEND_WINDOW_MS, BRAIN_RETIRED_RUNS_SCOPE_ID, runBrainExtraction,
  type BrainClaimModel, type BrainExtractionOptions, type BrainExtractionStore,
} from "../../packages/gateway/src/brain/claims/index.js";
import { BRAIN_MODEL_WIRE_FORMAT } from "../../packages/gateway/src/brain/claims/model/client.js";
import { createBrainClaimModelProvider, parseBrainModelConfig } from "../../packages/gateway/src/brain/claims/model/config.js";
import { BRAIN_MODEL_PRICES, brainModelUsage } from "../../packages/gateway/src/brain/claims/model/pricing.js";
import { BRAIN_MODEL_SYSTEM_PROMPT, brainModelUserContent } from "../../packages/gateway/src/brain/claims/model/prompt.js";
import {
  BRAIN_MODEL_BILLED_ATTEMPTS_PER_CALL, BRAIN_MODEL_PROMPT_OVERHEAD_TOKENS, brainModelAttemptWorstCostMicroUsd,
  brainModelCallWorstCostMicroUsd, brainModelSpendView, brainSpendStop, readBrainModelSpend,
} from "../../packages/gateway/src/brain/claims/spend.js";
import type { BrainRepository, BrainScopeKey } from "../../packages/gateway/src/brain/index.js";
import { SYNTHETIC_KEY } from "./helpers/brain-model-fetch.js";
import { createBrainHarness, manualDocument, scopeA, scopeB, type BrainHarness } from "./helpers/brain-store-helpers.js";

const MODEL = { kind: "model", modelId: "claude-opus-5-5", promptVersion: "claims-v2" } as const;
const EXTRACTOR = "model:claude-opus-5-5/claims-v2";
const DAY = 24 * 60 * 60_000;
const BODY = "- **Storage:** keep one transaction per document so a crash never leaves half of the claims behind.";
const WORST = brainModelCallWorstCostMicroUsd(Buffer.byteLength(`Title d0${BODY}`, "utf8"));
/** The per-run cost cap out of the way, so only the 30-day cap stops a run. */
const capped = (spendMicroUsdPer30d: number) => ({ spendMicroUsdPer30d, costMicroUsdPerRun: 50_000_000 });
const STORE_METHODS = ["getDocument", "listPendingExtractions", "openExtractionRun", "applyDocumentExtraction",
  "closeExtractionRun"] as const;
const ZERO_COUNTS = { documentsProcessed: 0, documentsFailed: 0, claimsWritten: 0, claimsRemoved: 0, claimsRejected: 0,
  quotesRejected: 0 };
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** A model that costs costMicroUsd per call and finds nothing, after gate when one is given. */
const costing = (costMicroUsd: number, gate?: Promise<unknown>): BrainClaimModel => ({
  extract: vi.fn(async () => {
    await gate;
    return { claims: [], usage: { inputTokens: 10, outputTokens: 5, costMicroUsd } };
  }) as unknown as BrainClaimModel["extract"],
});

describe("brain model spend cap", { timeout: 60_000 }, () => {
  let h: BrainHarness;
  let warn: MockInstance<typeof console.warn>;
  beforeEach(async () => { h = await createBrainHarness(); warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(async () => { warn.mockRestore(); await h.destroy(); });

  const extract = (overrides: Partial<BrainExtractionOptions> = {}) => runBrainExtraction({
    repository: h.repository, scope: scopeA, extractor: MODEL, now: () => h.now().getTime(), ...overrides,
  });
  const seed = async (count: number, scope: BrainScopeKey = scopeA) => {
    for (let n = 0; n < count; n += 1) await h.repository.upsertDocument(scope, manualDocument(`d${n}`,
      { body: BODY, provenance: "git_commit", sourceUpdatedAt: `2026-09-0${n + 1}T00:00:00Z` }));
  };
  /** A finished run row, as another process would leave it. */
  const insertRun = (scope: BrainScopeKey, startedAt: Date, cost: number, extractor = EXTRACTOR) =>
    h.db.insertInto("brain_extraction_runs").values({
      owner_id: scope.ownerId, scope_id: scope.scopeId, run_id: `xrn_${randomUUID().replaceAll("-", "")}`, extractor,
      status: "succeeded", cost_microusd: cost, error_code: null, started_at: startedAt, finished_at: startedAt,
    }).execute();
  const ago = (ms: number) => new Date(h.now().getTime() - ms);
  const runCount = async () => (await h.db.selectFrom("brain_extraction_runs").select("cost_microusd")
    .where("scope_id", "=", scopeA.scopeId).execute()).length;

  describe("the worst case of one call and the stop rule", () => {
    it("prices every billed attempt at the dearest rates, with a prompt allowance above the fixed request text", () => {
      // A token is at least one byte: the system prompt, the output schema and the tags around the title and body.
      const fixed = bytes(BRAIN_MODEL_SYSTEM_PROMPT) + bytes(JSON.stringify(BRAIN_MODEL_WIRE_FORMAT))
        + brainModelUserContent({ title: "", body: "" }).reduce((sum, block) => sum + bytes(block.text), 0);
      expect(fixed).toBeLessThan(BRAIN_MODEL_PROMPT_OVERHEAD_TOKENS);
      // Two SDK attempts, each up to three models: the requested one, then its two default fallbacks in turn.
      expect(BRAIN_MODEL_BILLED_ATTEMPTS_PER_CALL).toBe(6);
      // (8,192 prompt tokens at 6.3 + 8,192 output tokens at 25 micro-USD), rounded up, six times.
      expect(brainModelCallWorstCostMicroUsd(0)).toBe(1_538_460);
      expect(brainModelCallWorstCostMicroUsd(10_000) - brainModelCallWorstCostMicroUsd(0)).toBe(6 * 63_000);
      expect(brainModelAttemptWorstCostMicroUsd(0)).toBe(1_538_460 / 2); // one SDK attempt: three hops, no retry
    });

    it("covers the dearest usage pricing.ts can bill for one call, every hop and retry included", () => {
      const models = [...Object.keys(BRAIN_MODEL_PRICES), "claude-model-not-priced"];
      for (const inputBytes of [0, 1, 777, 32_768, 65_536 + 1_024]) {
        const tokens = inputBytes + BRAIN_MODEL_PROMPT_OVERHEAD_TOKENS;
        const shapes = [[tokens, 0, 0], [0, tokens, 0], [0, 0, tokens]] as const;
        const costs = models.flatMap((model) => shapes.map(([input, write, read]) => {
          // One response: the requested model and each fallback hop, every one at this model's rates.
          const hop = { type: "message", model, input_tokens: input, cache_creation_input_tokens: write,
            cache_read_input_tokens: read, output_tokens: BRAIN_MODEL_MAX_TOKENS };
          const iterations = Object.keys(BRAIN_MODEL_PRICES).map(() => hop);
          return (1 + BRAIN_MODEL_MAX_RETRIES) * brainModelUsage({ ...hop, iterations }, "claude-opus-5-5").costMicroUsd;
        }));
        const worst = brainModelCallWorstCostMicroUsd(inputBytes);
        expect(Math.max(...costs)).toBeLessThanOrEqual(worst);
        // Tight: only the rounding of each billed attempt separates the bound from the dearest bill.
        expect(worst - Math.max(...costs)).toBeLessThan(BRAIN_MODEL_BILLED_ATTEMPTS_PER_CALL);
      }
    });

    it("starts a call only when the budget left covers its worst case, and fails closed on unknown spend", () => {
      const total = { since: "2026-09-01T10:00:00.000Z", costMicroUsd: 1_000_000, billedRuns: 3 };
      const cap = 1_000_000 + 200 + brainModelCallWorstCostMicroUsd(0);
      expect(brainSpendStop(total, cap, 200, 0)).toBeNull();
      expect(brainSpendStop(total, cap, 201, 0)).toBe("spend_cap_reached");
      expect(brainSpendStop(null, cap, 0, 0)).toBe("store_unavailable");
      expect(brainSpendStop({ ...total, billedRuns: BRAIN_MODEL_SPEND_BILLED_RUNS_MAX }, 500_000_000, 0, 0))
        .toBe("spend_cap_reached");
      expect(brainModelSpendView(total, 1_500_000, 700_000))
        .toEqual({ windowStart: total.since, capMicroUsd: 1_500_000, spentMicroUsd: 1_700_000, remainingMicroUsd: 0 });
      expect(brainModelSpendView({ ...total, billedRuns: BRAIN_MODEL_SPEND_BILLED_RUNS_MAX }, 9_000_000, 0))
        .toMatchObject({ spentMicroUsd: 1_000_000, remainingMicroUsd: 0 });
    });
  });

  describe("the window", () => {
    it("sums billed runs of the owner, every scope, that started in the last 30 days, by the repository clock", async () => {
      expect(await h.repository.readModelSpend(scopeA))
        .toEqual({ since: ago(BRAIN_MODEL_SPEND_WINDOW_MS).toISOString(), costMicroUsd: 0, billedRuns: 0 });
      await insertRun(scopeA, ago(BRAIN_MODEL_SPEND_WINDOW_MS), 1_000);
      await insertRun(scopeA, ago(BRAIN_MODEL_SPEND_WINDOW_MS - 1), 20);
      await insertRun(scopeA, ago(DAY), 300);
      await insertRun(scopeA, ago(DAY), 0, "rules/v1");
      await insertRun(scopeB, ago(DAY), 4_000);
      await insertRun({ ownerId: "owner_b", scopeId: scopeA.scopeId }, ago(DAY), 50_000);
      // One budget per owner: a second project of the same owner shares it, another owner's runs never count.
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 4_320, billedRuns: 3 });
      h.tick(2);
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 4_300, billedRuns: 2 });
      expect(await readBrainModelSpend(h.repository, scopeB)).toMatchObject({ costMicroUsd: 4_300, billedRuns: 2 });
      expect(await readBrainModelSpend(h.repository, { ownerId: "owner_b", scopeId: "x" }))
        .toMatchObject({ costMicroUsd: 50_000, billedRuns: 1 });
      expect(await readBrainModelSpend({}, scopeA)).toBeNull();
    });

    it("keeps an erased project's billed runs in the owner's spend until they leave the window", async () => {
      await insertRun(scopeA, ago(DAY), 3_000_000);
      await insertRun(scopeA, ago(DAY), 0, "rules/v1");
      await insertRun(scopeA, ago(BRAIN_MODEL_SPEND_WINDOW_MS + DAY), 9_000);
      const running = await h.repository.openExtractionRun(scopeA, { extractor: EXTRACTOR });
      await h.db.updateTable("brain_extraction_runs").set({ cost_microusd: 500 })
        .where("run_id", "=", running.runId).execute();
      await h.repository.eraseScope(scopeA);
      expect(await runCount()).toBe(0);
      expect(await h.repository.readModelSpend(scopeB)).toMatchObject({ costMicroUsd: 3_000_500, billedRuns: 2 });
      const retired = await h.db.selectFrom("brain_extraction_runs").select(["scope_id", "status", "cost_microusd"])
        .orderBy("cost_microusd").execute();
      expect(retired).toEqual([
        { scope_id: BRAIN_RETIRED_RUNS_SCOPE_ID, status: "interrupted", cost_microusd: 500 },
        { scope_id: BRAIN_RETIRED_RUNS_SCOPE_ID, status: "succeeded", cost_microusd: 3_000_000 },
      ]);
      // A model run in another project of the owner is held to the spend the erased project used.
      await seed(1, scopeB);
      const model = costing(1);
      expect(await extract({ model, scope: scopeB, limits: capped(3_000_500 + WORST - 1) }))
        .toMatchObject({ errorCode: "spend_cap_reached", spend: { spentMicroUsd: 3_000_500 } });
      expect(model.extract).not.toHaveBeenCalled();
      // Once out of the window, the next run that opens anywhere for the owner drops them.
      h.tick(BRAIN_MODEL_SPEND_WINDOW_MS);
      await extract({ scope: scopeB, extractor: { kind: "rules" } });
      expect(await h.db.selectFrom("brain_extraction_runs").select("run_id")
        .where("scope_id", "=", BRAIN_RETIRED_RUNS_SCOPE_ID).execute()).toEqual([]);
    });

    it("keeps the cost of a model call in flight when its project is erased", async () => {
      await seed(1);
      let release: (value?: unknown) => void = () => undefined;
      const model = costing(700, new Promise((resolve) => { release = resolve; }));
      const running = extract({ model, limits: capped(10 * WORST) });
      await vi.waitFor(() => expect(model.extract).toHaveBeenCalledTimes(1));
      await h.repository.eraseScope(scopeA);
      release();
      expect(await running).toMatchObject({ errorCode: "run_superseded", usage: { costMicroUsd: 700 } });
      expect(await h.repository.readModelSpend(scopeB)).toMatchObject({ costMicroUsd: 700, billedRuns: 1 });
    });

    it("keeps billed runs inside the window past the 50-run prune, then prunes them once they age out", async () => {
      await insertRun(scopeA, ago(10 * DAY), 2_000_000);
      for (let n = 0; n < 60; n += 1) await insertRun(scopeA, ago(9 * DAY - n * 1_000), 0, "rules/v1");
      expect(await extract({ extractor: { kind: "rules" } })).toMatchObject({ status: "succeeded" });
      expect(await runCount()).toBe(51);
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 2_000_000, billedRuns: 1 });
      h.tick(21 * DAY);
      await extract({ extractor: { kind: "rules" } });
      expect(await runCount()).toBe(50);
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 0, billedRuns: 0 });
    });
  });

  describe("the stop", () => {
    it("stops before the call its budget cannot cover, with raise_budget, and resumes as the window moves", async () => {
      await seed(3);
      const model = costing(1_000_000);
      const cap = 1_000_000 + WORST;
      const first = await extract({ model, limits: capped(cap) });
      expect(model.extract).toHaveBeenCalledTimes(2);
      expect(first).toMatchObject({
        status: "failed", errorCode: "spend_cap_reached", nextAction: "raise_budget", caughtUp: false,
        counts: { documentsProcessed: 2 }, usage: { costMicroUsd: 2_000_000 },
        run: { status: "failed", errorCode: "spend_cap_reached", nextAction: "raise_budget" },
        spend: { windowStart: ago(BRAIN_MODEL_SPEND_WINDOW_MS).toISOString(), capMicroUsd: cap, spentMicroUsd: 2_000_000,
          remainingMicroUsd: cap - 2_000_000 },
      });
      expect(JSON.stringify(warn.mock.calls)).toContain("spend_cap_reached");
      // The closed run now counts: the next run stops before any call.
      h.tick(1_000);
      expect(await extract({ model, limits: capped(cap) })).toMatchObject({
        errorCode: "spend_cap_reached", counts: { documentsProcessed: 0 }, spend: { spentMicroUsd: 2_000_000 },
      });
      expect(model.extract).toHaveBeenCalledTimes(2);
      // 30 days after the billed run started, it has left the window.
      h.tick(BRAIN_MODEL_SPEND_WINDOW_MS - 1_000);
      expect(await extract({ model, limits: capped(cap) })).toMatchObject({
        status: "succeeded", caughtUp: true, counts: { documentsProcessed: 1 }, spend: { spentMicroUsd: 1_000_000 },
      });
    });

    it("defaults to 5 USD per 30 days and stops at a full ledger of billed runs", async () => {
      expect(BRAIN_EXTRACTION_DEFAULT_LIMITS.spendMicroUsdPer30d).toBe(5_000_000);
      await seed(1);
      const model = costing(1);
      await insertRun(scopeA, ago(DAY), 5_000_000 - WORST + 1);
      expect(await extract({ model })).toMatchObject({ errorCode: "spend_cap_reached", spend: { capMicroUsd: 5_000_000 } });
      await h.db.deleteFrom("brain_extraction_runs").execute();
      await h.db.insertInto("brain_extraction_runs").values(Array.from({ length: BRAIN_MODEL_SPEND_BILLED_RUNS_MAX },
        (_, n) => ({ owner_id: scopeA.ownerId, scope_id: scopeA.scopeId, run_id: `xrn_${randomUUID().replaceAll("-", "")}`,
          extractor: EXTRACTOR, status: "succeeded" as const, cost_microusd: 1, error_code: null,
          started_at: ago(DAY + n), finished_at: ago(DAY + n) }))).execute();
      expect(await extract({ model, limits: capped(500_000_000) })).toMatchObject({
        errorCode: "spend_cap_reached", spend: { spentMicroUsd: BRAIN_MODEL_SPEND_BILLED_RUNS_MAX, remainingMicroUsd: 0 },
      });
      expect(model.extract).not.toHaveBeenCalled();
    });

    it("never calls a model through a store that cannot report spend, and ignores spend on rules runs", async () => {
      await seed(1);
      const model = costing(1);
      const bare = Object.fromEntries(STORE_METHODS.map((name) => [name, h.repository[name].bind(h.repository)]));
      expect(await extract({ model, repository: bare as unknown as BrainExtractionStore })).toMatchObject({
        status: "failed", errorCode: "store_unavailable", run: { errorCode: "store_unavailable" },
      });
      expect((await extract({ model, repository: bare as unknown as BrainExtractionStore })).spend).toBeUndefined();
      // An abort still stops the run as an abort, not as unknown spend.
      const controller = new AbortController();
      const aborting = { ...bare, getDocument: (scope: BrainScopeKey, id: string) =>
        (controller.abort(), h.repository.getDocument(scope, id)) };
      expect(await extract({ model, repository: aborting as unknown as BrainExtractionStore, signal: controller.signal }))
        .toMatchObject({ status: "succeeded", errorCode: null, nextAction: "run_again" });
      const broken = { ...bare, readModelSpend: async () => { throw new Error("postgres down"); } };
      expect(await extract({ model, repository: broken as unknown as BrainExtractionStore }))
        .toMatchObject({ errorCode: "store_unavailable", counts: { documentsProcessed: 0 } });
      expect(model.extract).not.toHaveBeenCalled();
      const readModelSpend = vi.spyOn(h.repository, "readModelSpend");
      const rules = await extract({ extractor: { kind: "rules" } });
      expect(rules).toMatchObject({ status: "succeeded" });
      expect(rules.spend).toBeUndefined();
      expect(readModelSpend).not.toHaveBeenCalled();
    });
  });

  describe("calls that never answer", () => {
    it("charges a call that timed out, or was aborted after it was sent, at its worst case", async () => {
      await seed(2);
      const hung: BrainClaimModel = { extract: vi.fn(() => new Promise<never>(() => undefined)) as never };
      const timedOut = await extract({ model: hung, limits: { ...capped(50_000_000), modelCallTimeoutMs: 20, documentsPerRun: 1 } });
      expect(timedOut).toMatchObject({
        counts: { documentsProcessed: 1, documentsFailed: 1 }, usage: { costMicroUsd: WORST },
        run: { usage: { costMicroUsd: WORST } }, spend: { spentMicroUsd: WORST },
      });
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: WORST, billedRuns: 1 });
      // A stop during the call (cancel, time cap, shutdown) ends the run and still counts the call.
      const controller = new AbortController();
      const stopped: BrainClaimModel = { extract: vi.fn(() => {
        setTimeout(() => controller.abort("cancelled"), 5);
        return new Promise<never>(() => undefined);
      }) as never };
      h.tick(1_000);
      const aborted = await extract({ model: stopped, signal: controller.signal, limits: capped(50_000_000) });
      expect(aborted).toMatchObject({ counts: { documentsProcessed: 0 }, usage: { costMicroUsd: WORST }, caughtUp: false });
      expect(stopped.extract).toHaveBeenCalledTimes(1);
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 2 * WORST, billedRuns: 2 });
      h.tick(1_000); // A run stopped before its first call costs nothing.
      expect((await extract({ model: stopped, signal: AbortSignal.abort(), limits: capped(50_000_000) })).usage.costMicroUsd).toBe(0);
      expect(stopped.extract).toHaveBeenCalledTimes(1);
    });
  });

  describe("runs that never close", () => {
    it("saves the run's cost on every apply, a stale one too, and never lowers it", async () => {
      await seed(1);
      const [document] = await h.db.selectFrom("brain_documents").select(["document_id", "incarnation", "revision"])
        .where("scope_id", "=", scopeA.scopeId).execute();
      const run = await h.repository.openExtractionRun(scopeA, { extractor: EXTRACTOR });
      const apply = (runCostMicroUsd: number, revision = document!.revision) => h.repository.applyDocumentExtraction(
        scopeA, { runId: run.runId, documentId: document!.document_id, incarnation: document!.incarnation, revision,
          extractor: EXTRACTOR, outcome: { status: "failed", errorCode: "model_failed" }, runCostMicroUsd });
      const spent = async () => (await h.repository.readModelSpend(scopeA)).costMicroUsd;
      expect(await apply(300, document!.revision + 1)).toEqual({ applied: false, reason: "stale" });
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 300, billedRuns: 1 });
      expect(await apply(200)).toMatchObject({ applied: true });
      expect(await spent()).toBe(300);
      await expect(apply(-1)).rejects.toMatchObject({ code: "invalid" });
      expect(await h.repository.closeExtractionRun(scopeA, { runId: run.runId, status: "failed", counts: ZERO_COUNTS,
        usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 100 }, nextAction: "retry_later", errorCode: "internal_error",
      })).toMatchObject({ status: "failed", usage: { costMicroUsd: 300 } });
      await expect(apply(900)).rejects.toMatchObject({ code: "conflict" });
      expect(await spent()).toBe(300);
    });

    it("counts a run that never closed once its lease ends, so a lost run cannot hand its budget back", async () => {
      await seed(3);
      const model = costing(1_000_000);
      const store = Object.fromEntries([...STORE_METHODS, "readModelSpend"].map((name) =>
        [name, (h.repository[name as keyof BrainExtractionStore] as () => unknown).bind(h.repository)]));
      // The process dies before its close: the row stays running with what its applies saved.
      const lost = { ...store, closeExtractionRun: async () => { throw new Error("process gone"); } };
      expect(await extract({ model, repository: lost as unknown as BrainExtractionStore,
        limits: { ...capped(50_000_000), documentsPerRun: 2 } }))
        .toMatchObject({ run: null, counts: { documentsProcessed: 2 }, usage: { costMicroUsd: 2_000_000 } });
      expect(await h.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 2_000_000, billedRuns: 1 });
      h.tick(BRAIN_EXTRACTION_RUN_LEASE_MS);
      expect(await extract({ model, limits: capped(2_000_000 + WORST - 1) })).toMatchObject({
        errorCode: "spend_cap_reached", counts: { documentsProcessed: 0 }, spend: { spentMicroUsd: 2_000_000 },
      });
      expect(model.extract).toHaveBeenCalledTimes(2);
      expect(await h.db.selectFrom("brain_extraction_runs").select(["status", "cost_microusd"])
        .where("scope_id", "=", scopeA.scopeId).orderBy("started_at").execute())
        .toEqual([{ status: "interrupted", cost_microusd: 2_000_000 }, { status: "failed", cost_microusd: 0 }]);
    });
  });

  describe("concurrent runs", () => {
    it("counts a run another process held once it closes, and refuses to run beside it", async () => {
      await seed(1);
      const model = costing(1);
      const readModelSpend = vi.spyOn(h.repository, "readModelSpend");
      const other = await h.repository.openExtractionRun(scopeA, { extractor: EXTRACTOR });
      expect(await extract({ model })).toMatchObject({ errorCode: "extraction_in_progress", run: null });
      expect(readModelSpend).not.toHaveBeenCalled();
      await h.repository.closeExtractionRun(scopeA, { runId: other.runId, status: "succeeded", counts: ZERO_COUNTS,
        usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1_500_000 }, nextAction: "", errorCode: null });
      expect(await extract({ model, limits: capped(1_500_000 + WORST - 1) }))
        .toMatchObject({ errorCode: "spend_cap_reached", spend: { spentMicroUsd: 1_500_000 } });
      expect(model.extract).not.toHaveBeenCalled();
    });

    it("runs one model run per owner at a time, and holds every project of the owner to one budget", async () => {
      await seed(3);
      await seed(2, scopeB);
      const model = costing(1_000_000);
      const limits = capped(1_000_000 + WORST);
      const [a, b, other] = await Promise.all([
        extract({ model, limits }), extract({ model, limits }), extract({ model, limits, scope: scopeB }),
      ]);
      expect([a.errorCode, b.errorCode, other.errorCode].sort())
        .toEqual(["extraction_in_progress", "extraction_in_progress", "spend_cap_reached"]);
      expect(model.extract).toHaveBeenCalledTimes(2);
      // The other project now finds the owner's budget spent, before any call.
      expect(await extract({ model, limits, scope: scopeB })).toMatchObject({ errorCode: "spend_cap_reached", spend: { spentMicroUsd: 2_000_000 } });
      expect(model.extract).toHaveBeenCalledTimes(2);
      expect(await h.repository.readModelSpend(scopeB)).toMatchObject({ costMicroUsd: 2_000_000, billedRuns: 1 });
      // A rules run beside a model run of the same owner is never held back.
      let release = (): void => undefined;
      const slow = costing(1, new Promise<void>((resolve) => { release = resolve; }));
      h.tick(BRAIN_MODEL_SPEND_WINDOW_MS);
      const pending = extract({ model: slow, limits });
      expect(await extract({ scope: scopeB, extractor: { kind: "rules" } })).toMatchObject({ status: "succeeded" });
      release();
      expect(await pending).toMatchObject({ errorCode: null });
    });
  });

  describe("configuration", () => {
    const VARIABLE = "MATRIX_BRAIN_MODEL_SPEND_MICROUSD_PER_30D";
    it("reads the cap from the environment and passes it to every model run", async () => {
      expect(parseBrainModelConfig({})).toMatchObject({ ok: true, config: { spendMicroUsdPer30d: 5_000_000 } });
      expect(parseBrainModelConfig({ [VARIABLE]: " 500000000 " }))
        .toMatchObject({ ok: true, config: { spendMicroUsdPer30d: 500_000_000 } });
      for (const value of ["0", "500000001", "1e6", "-5", "2.5"]) {
        expect(parseBrainModelConfig({ [VARIABLE]: value })).toEqual({ ok: false, variable: VARIABLE });
      }
      const home = await mkdtemp(join(tmpdir(), "brain-spend-"));
      try {
        const env = { ANTHROPIC_API_KEY: SYNTHETIC_KEY, [VARIABLE]: "7000000" };
        expect((await createBrainClaimModelProvider({ homePath: home, env })())?.limits)
          .toMatchObject({ spendMicroUsdPer30d: 7_000_000 });
        expect(await createBrainClaimModelProvider({ homePath: home, env: { ...env, [VARIABLE]: "0" } })()).toBeNull();
        expect(JSON.stringify(warn.mock.calls)).toContain(VARIABLE);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  });
});

// Two gateway processes on one database: each loads its own module graph (its own in-process guard and classes), so
// only the running run row decides. Only a disposable server is appropriate: the test creates its own schema.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!databaseUrl)("brain model spend cap across PostgreSQL connections", { timeout: 60_000 }, () => {
  let admin: pg.Pool;
  let schema: string;
  let url: URL;
  const repositories: BrainRepository[] = [];
  beforeEach(async () => {
    schema = `brain_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
  });
  afterEach(async () => {
    for (const repository of repositories.splice(0)) await repository.destroy();
    if (schema && admin) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  /** One process: a fresh module graph with its own repository on its own pool. */
  const startProcess = async () => {
    vi.resetModules();
    const { runBrainExtraction: run } = await import("../../packages/gateway/src/brain/claims/job.js");
    const { BrainRepository: Repository } = await import("../../packages/gateway/src/brain/index.js");
    const clock = new Date("2026-10-01T10:00:00.000Z");
    const repository = new Repository(new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 2 }) }), { now: () => clock });
    repositories.push(repository);
    await repository.bootstrap();
    return { run, repository };
  };

  it("lets one process run at a time and makes the next one see its spend", async () => {
    const processes = [await startProcess(), await startProcess()];
    expect(processes[0]!.run).not.toBe(processes[1]!.run);
    for (const seed of ["d0", "d1", "d2"]) {
      await processes[0]!.repository.upsertDocument(scopeA, manualDocument(seed, { body: BODY, provenance: "git_pr" }));
    }
    // The run that opens first waits in its first call until the other has been turned away.
    let release = (): void => undefined;
    const model = costing(1_000_000, new Promise<void>((resolve) => { release = resolve; }));
    const limits = capped(1_000_000 + WORST);
    const extractIn = ({ run, repository }: (typeof processes)[number]) =>
      run({ repository, scope: scopeA, extractor: MODEL, model, limits });
    const runs = processes.map(extractIn);
    expect(await Promise.race(runs)).toMatchObject({ errorCode: "extraction_in_progress", run: null });
    release();
    const results = await Promise.all(runs);
    expect(results.map((result) => result.errorCode).sort()).toEqual(["extraction_in_progress", "spend_cap_reached"]);
    expect(model.extract).toHaveBeenCalledTimes(2);
    for (const process of processes) {
      expect(await extractIn(process)).toMatchObject({ errorCode: "spend_cap_reached", spend: { spentMicroUsd: 2_000_000 } });
    }
    expect(model.extract).toHaveBeenCalledTimes(2);
    expect(await processes[1]!.repository.readModelSpend(scopeA)).toMatchObject({ costMicroUsd: 2_000_000, billedRuns: 1 });
  });
});
