/**
 * Company Brain model spend cap: a rolling limit per owner, across all of the owner's projects, on what model
 * extraction may cost over the last 30 days. The spend is summed from the cost of the owner's extraction runs
 * (brain_extraction_runs, every scope, including the billed runs a project erase keeps under
 * BRAIN_RETIRED_RUNS_SCOPE_ID); a model run reads it once after its run opens, adds its own cost as it goes and saves
 * that total on its row with each document's write, so a run that never closes still counts. One model run per owner
 * runs at a time in a process (job.ts), so the read is not stale within one gateway; two gateways of one owner could
 * each spend at most one run's budget past the cap. Before each model call the remaining budget must cover the worst
 * case of that call. A call that timed out, was aborted after it was sent or lost its answer is charged at that worst
 * case, since no usage comes back; only the call in flight when a run is lost (a crash) goes uncounted.
 */
import type { BrainExecutor } from "../documents.js";
import type { BrainScopeKey } from "../types.js";
import { BRAIN_MODEL_PRICES } from "./model/pricing.js";
import { BRAIN_MODEL_MAX_RETRIES, BRAIN_MODEL_MAX_TOKENS } from "./model/types.js";
import {
  BRAIN_MODEL_SPEND_BILLED_RUNS_MAX, BRAIN_MODEL_SPEND_WINDOW_MS, type BrainExtractionErrorCode,
  type BrainExtractionStore, type BrainModelSpend, type BrainModelSpendTotal,
} from "./types.js";

/** Prompt tokens beside the title and body: the system prompt (about 4.4 KB), the output schema and the tags. */
export const BRAIN_MODEL_PROMPT_OVERHEAD_TOKENS = 8_192;
/**
 * Models one SDK attempt can bill: the requested model, then each `fallbacks: "default"` target in turn while they
 * decline. Every one of them is priced in pricing.ts, so the price table bounds the chain.
 */
export const BRAIN_MODEL_HOPS_PER_ATTEMPT = Object.keys(BRAIN_MODEL_PRICES).length;
/** Billed attempts one call can carry: each SDK attempt (the first and its retry) times every hop of its chain. */
export const BRAIN_MODEL_BILLED_ATTEMPTS_PER_CALL = (1 + BRAIN_MODEL_MAX_RETRIES) * BRAIN_MODEL_HOPS_PER_ATTEMPT;

const prices = Object.values(BRAIN_MODEL_PRICES);
/** Tenths of a micro-USD: every input token at the dearest input or cache write rate, output at the dearest rate. */
const INPUT_RATE = Math.max(...prices.flatMap((price) => [price.input, price.cacheWrite]));
const OUTPUT_RATE = Math.max(...prices.map((price) => price.output));

/**
 * The most one SDK attempt can cost, in micro-USD, for a title and body of inputBytes utf8 bytes: a token is at least
 * one byte, and every hop of its fallback chain reads the whole prompt and writes max_tokens.
 */
export function brainModelAttemptWorstCostMicroUsd(inputBytes: number): number {
  const tenths = (inputBytes + BRAIN_MODEL_PROMPT_OVERHEAD_TOKENS) * INPUT_RATE + BRAIN_MODEL_MAX_TOKENS * OUTPUT_RATE;
  return BRAIN_MODEL_HOPS_PER_ATTEMPT * Math.ceil(tenths / 10);
}

/** The most one model call can cost: every SDK attempt (the first and its retry) at its worst case. */
export function brainModelCallWorstCostMicroUsd(inputBytes: number): number {
  return (1 + BRAIN_MODEL_MAX_RETRIES) * brainModelAttemptWorstCostMicroUsd(inputBytes);
}

/**
 * Cost and count of the owner's runs, in every scope, that cost anything and started after now minus the window,
 * whatever their status: an interrupted run keeps the cost its writes saved. A model run reads this right after its
 * own run opens, while its row still has cost 0. The billed index bounds the scan, and the prunes in store.ts keep
 * these rows (at most BRAIN_MODEL_SPEND_BILLED_RUNS_MAX, see brainSpendStop) until they leave the window.
 */
export async function selectBrainModelSpend(
  db: BrainExecutor, scope: BrainScopeKey, now: Date,
): Promise<BrainModelSpendTotal> {
  const since = new Date(now.getTime() - BRAIN_MODEL_SPEND_WINDOW_MS);
  const row = await db.selectFrom("brain_extraction_runs")
    .select((eb) => [eb.fn.sum<string | number | null>("cost_microusd").as("cost"), eb.fn.countAll<string | number>()
      .as("runs")])
    .where("owner_id", "=", scope.ownerId)
    .where("cost_microusd", ">", 0).where("started_at", ">", since)
    .executeTakeFirstOrThrow();
  return { since: since.toISOString(), costMicroUsd: Number(row.cost ?? 0), billedRuns: Number(row.runs) };
}

/** The window's spend, or null when the store cannot report it (such a store never gets a model call). */
export async function readBrainModelSpend(
  store: Pick<BrainExtractionStore, "readModelSpend">, scope: BrainScopeKey,
): Promise<BrainModelSpendTotal | null> {
  return store.readModelSpend === undefined ? null : store.readModelSpend(scope);
}

/** The cap as a result reports it; runCostMicroUsd is what the current run has spent so far (0 outside a run). */
export function brainModelSpendView(
  total: BrainModelSpendTotal, capMicroUsd: number, runCostMicroUsd: number,
): BrainModelSpend {
  const spentMicroUsd = total.costMicroUsd + runCostMicroUsd;
  const full = total.billedRuns >= BRAIN_MODEL_SPEND_BILLED_RUNS_MAX;
  return {
    windowStart: total.since, capMicroUsd, spentMicroUsd,
    remainingMicroUsd: full ? 0 : Math.max(0, capMicroUsd - spentMicroUsd),
  };
}

/**
 * Why the next model call must not start, or null to start it. Unknown spend is store_unavailable (fail closed); a
 * remaining budget below the call's worst case, or a window already holding BRAIN_MODEL_SPEND_BILLED_RUNS_MAX billed
 * runs (so the spend could no longer be summed in full), is spend_cap_reached.
 */
export function brainSpendStop(
  total: BrainModelSpendTotal | null, capMicroUsd: number, runCostMicroUsd: number, inputBytes: number,
): BrainExtractionErrorCode | null {
  if (total === null) return "store_unavailable";
  const { remainingMicroUsd } = brainModelSpendView(total, capMicroUsd, runCostMicroUsd);
  return remainingMicroUsd < brainModelCallWorstCostMicroUsd(inputBytes) ? "spend_cap_reached" : null;
}
