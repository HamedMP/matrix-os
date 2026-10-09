/**
 * Claim extraction job: one scope's pending documents (rules oldest first, model newest first; only the provenances
 * the options name, when they name any, and for a model never one outside BRAIN_MODEL_PROVENANCES), each extracted
 * (the current rules version, or a model through verification) and applied in its own fenced store transaction,
 * within document, byte, time, token and cost budgets and, for a model, the owner's 30-day spend cap (spend.ts).
 * Never rejects: every failure is a result code, recorded on the run once one is open. Logs carry codes only.
 */
import { z } from "zod/v4";
import { BrainScopeKeySchema } from "../schemas.js";
import { BrainPendingExtractionQuerySchema } from "./schemas.js";
import { BrainStoreError, type BrainDocument, type BrainScopeKey } from "../types.js";
import { BRAIN_MODEL_SKIP_CODES, BrainClaimModelOutcomeSchema, BrainModelError } from "./model/types.js";
import { claimSourceText, extractRulesClaims } from "./rules.js";
import {
  brainModelCallWorstCostMicroUsd, brainModelSpendView, brainSpendStop, readBrainModelSpend,
} from "./spend.js";
import {
  BRAIN_CLAIM_KINDS, BRAIN_CLAIMS_PER_DOCUMENT_MAX, BRAIN_EXTRACTION_DEFAULT_LIMITS, BRAIN_EXTRACTION_LIMIT_CEILINGS,
  BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS, BRAIN_EXTRACTOR_ID_MAX_CHARS, BRAIN_EXTRACTOR_ID_PATTERN, BRAIN_MODEL_PROVENANCES,
  BRAIN_RULES_EXTRACTOR_ID, BrainExtractionUsageSchema, brainModelExtractorId, type BrainApplyDocumentExtractionResult,
  type BrainClaimKind, type BrainClaimModel, type BrainCloseExtractionRunInput, type BrainDocumentExtractionOutcome,
  type BrainExtractionCounts, type BrainExtractionErrorCode, type BrainExtractionLimits, type BrainExtractionNextAction,
  type BrainExtractionOptions, type BrainExtractionResult, type BrainExtractionRun, type BrainExtractionStore,
  type BrainExtractionUsage, type BrainModelSpendTotal,
} from "./types.js";
import { verifyModelClaims } from "./verify.js";

/**
 * In-process re-entry guard keyed by [ownerId, scopeId]: capped at BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS entries,
 * each deleted in finally. Across processes the scope's running run row and the run fence on every write guard.
 */
const runningExtractions = new Set<string>();
/**
 * Owners with a model run in this process (at most one each, so a run's read of the owner's 30-day spend is never
 * stale here); bounded by runningExtractions' cap, each deleted in finally.
 */
const runningModelOwners = new Set<string>();

const NEXT_ACTIONS: Readonly<Record<BrainExtractionErrorCode, BrainExtractionNextAction>> = {
  invalid_options: "contact_support", model_not_configured: "configure_model", extraction_in_progress: "retry_later",
  store_unavailable: "retry_later", claims_capacity: "raise_capacity", run_superseded: "retry_later",
  model_usage_invalid: "contact_support", internal_error: "contact_support", model_auth_failed: "configure_model",
  model_unavailable: "retry_later", model_rejected: "contact_support", spend_cap_reached: "raise_budget",
};

const LIMIT_KEYS = Object.keys(BRAIN_EXTRACTION_DEFAULT_LIMITS) as (keyof BrainExtractionLimits)[];
const USAGE_KEYS = ["inputTokens", "outputTokens", "costMicroUsd", "cacheReadTokens", "cacheWriteTokens"] as const;
const idPart = z.string().min(1).max(BRAIN_EXTRACTOR_ID_MAX_CHARS);
/** Unknown option keys (repository, model, signal, now) pass through untouched; limits and extractor are strict. */
const OptionsSchema = z.object({
  scope: BrainScopeKeySchema,
  provenances: BrainPendingExtractionQuerySchema.shape.provenances,
  limits: z.object(Object.fromEntries(LIMIT_KEYS.map((key) => [key, z.number().int().min(1).optional()]))).strict()
    .optional(),
  extractor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("rules") }).strict(),
    z.object({
      kind: z.literal("model"), modelId: idPart, promptVersion: idPart,
      kinds: z.array(z.enum(BRAIN_CLAIM_KINDS)).min(1).max(BRAIN_CLAIM_KINDS.length)
        .refine((kinds) => kinds.every((kind, index) => kinds.indexOf(kind) === index)).optional(),
    }).strict(),
  ]),
});

/**
 * One extraction: its parsed options and, once its run is open, the tallies closeExtractionRun records. stopAfter: a
 * model_rejected error whose document is recorded first; the run then stops with its code. spend: the owner's 30-day
 * model spend read after a model run opens; null for rules runs and stores that cannot report it.
 */
interface Extraction {
  readonly store: BrainExtractionStore; readonly scope: BrainScopeKey; readonly extractor: string;
  readonly kinds: readonly BrainClaimKind[]; readonly model: BrainClaimModel | undefined;
  readonly provenances: readonly string[] | undefined;
  readonly limits: BrainExtractionLimits; readonly signal: AbortSignal | undefined; readonly now: () => number;
  readonly admit: (() => Promise<unknown>) | undefined;
  runId: string; startedAt: number; bytesRead: number; stopAfter: BrainModelError | null;
  spend: BrainModelSpendTotal | null;
  readonly counts: Record<keyof BrainExtractionCounts, number>;
  readonly usage: Record<keyof BrainExtractionUsage, number>;
}

/** Ends the run with a run-level code; thrown inside the loop, caught once in runOpened (which logs its cause). */
class ExtractionStop extends Error {
  constructor(readonly code: BrainExtractionErrorCode, options?: ErrorOptions) { super(code, options); }
}

function logFailure(event: string, error: unknown, code: string): void {
  console.warn(`[brain-claims] ${event}`, { code, name: error instanceof Error ? error.name : typeof error });
}

const zero = () => ({
  usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  counts: { documentsProcessed: 0, documentsFailed: 0, claimsWritten: 0, claimsRemoved: 0, claimsRejected: 0,
    quotesRejected: 0 },
});

const early = (code: BrainExtractionErrorCode, extractor: string): BrainExtractionResult =>
  ({ status: "failed", errorCode: code, nextAction: NEXT_ACTIONS[code], extractor, run: null, caughtUp: false, ...zero() });

/** The only provenances a model run may send to a third-party model, whatever the caller passed. */
const MODEL_SENDABLE: ReadonlySet<string> = new Set(BRAIN_MODEL_PROVENANCES);
/** The skip codes a model may answer for a revision it would not send; any other answer is ignored. */
const MODEL_SKIP_CODES: ReadonlySet<string> = new Set(BRAIN_MODEL_SKIP_CODES);

/** The extraction, or the early result of options that cannot run. Limits are clamped to their ceilings. */
function parseOptions(options: BrainExtractionOptions): Extraction | BrainExtractionResult {
  const parsed = OptionsSchema.safeParse(options);
  if (!parsed.success) return early("invalid_options", "");
  const { scope, limits, extractor: choice } = parsed.data;
  const model = choice.kind === "model" ? options.model : undefined;
  // A model run only ever lists (and sends) the git provenances; an empty list means nothing is sendable.
  const provenances = model === undefined ? parsed.data.provenances
    : (parsed.data.provenances ?? BRAIN_MODEL_PROVENANCES).filter((provenance) => MODEL_SENDABLE.has(provenance));
  const id = choice.kind === "model"
    ? brainModelExtractorId(choice.modelId, choice.promptVersion) : BRAIN_RULES_EXTRACTOR_ID;
  if (!BRAIN_EXTRACTOR_ID_PATTERN.test(id)) return early("invalid_options", "");
  if (choice.kind === "model" && model === undefined) return early("model_not_configured", id);
  const resolved: Record<keyof BrainExtractionLimits, number> = { ...BRAIN_EXTRACTION_DEFAULT_LIMITS };
  for (const key of LIMIT_KEYS) resolved[key] = Math.min(limits?.[key] ?? resolved[key], BRAIN_EXTRACTION_LIMIT_CEILINGS[key]);
  return {
    store: options.repository, scope, extractor: id, model, limits: resolved, provenances,
    kinds: (choice.kind === "model" ? choice.kinds : undefined) ?? BRAIN_CLAIM_KINDS, signal: options.signal,
    now: options.now ?? Date.now, admit: options.admit,
    runId: "", startedAt: 0, bytesRead: 0, stopAfter: null, spend: null, ...zero(),
  };
}

/** A Postgres data (class 22) or constraint (class 23) error: the store refused the values written. */
const refusedByPostgres = (error: unknown): boolean =>
  /^2[23][0-9A-Z]{3}$/.test(String((error as { readonly code?: unknown } | null)?.code));

const NOT_ALLOWED: BrainDocumentExtractionOutcome = { status: "skipped", errorCode: "provenance_not_allowed" };

/** Store reads: any failure is store_unavailable. */
const unavailable = (error: unknown): never => { throw new ExtractionStop("store_unavailable", { cause: error }); };

function rulesOutcome(state: Extraction, document: BrainDocument): BrainDocumentExtractionOutcome {
  try {
    const { claims, claimsRejected } = extractRulesClaims(document);
    state.counts.claimsRejected += claimsRejected;
    return { status: "done", claims };
  } catch (error) {
    logFailure("rules extractor failed", error, "extractor_error");
    return { status: "failed", errorCode: "extractor_error" };
  }
}

/**
 * A call that was sent but never answered (it timed out, the caller aborted it, or its answer was lost) or answered
 * without valid usage may still be billed, and no usable usage comes back: its worst case is added to the run's cost,
 * so the run row, the per-run budget and the 30-day cap count it.
 */
function chargeUnanswered(state: Extraction, inputBytes: number): void {
  state.usage.costMicroUsd += brainModelCallWorstCostMicroUsd(inputBytes);
}

/**
 * Null when the caller aborted during the call: the run stops and the document keeps its state. A BrainModelError
 * either fails the document (model_timeout, model_rejected) or stops the run (model_auth_failed, model_unavailable).
 * A timeout, an abort after the call started, an unanswered BrainModelError or invalid usage is charged at its worst
 * case (chargeUnanswered).
 */
async function modelOutcome(
  state: Extraction, model: BrainClaimModel, document: BrainDocument,
): Promise<BrainDocumentExtractionOutcome | null> {
  const text = claimSourceText(document);
  if (text.trim() === "") return { status: "done", claims: [] };
  const input = { title: document.title, body: text, kinds: state.kinds, maxClaims: BRAIN_CLAIMS_PER_DOCUMENT_MAX };
  // A revision the model would not send costs nothing, so it is skipped before the cap rather than left to block it.
  const skip = model.skip?.(input) ?? null;
  if (skip !== null && MODEL_SKIP_CODES.has(skip)) return { status: "skipped", errorCode: skip };
  // The 30-day cap: this call starts only when the budget left covers its worst case. An abort is handled below.
  const inputBytes = Buffer.byteLength(document.title, "utf8") + Buffer.byteLength(text, "utf8");
  const spendStop = state.signal?.aborted ? null
    : brainSpendStop(state.spend, state.limits.spendMicroUsdPer30d, state.usage.costMicroUsd, inputBytes);
  if (spendStop !== null) throw new ExtractionStop(spendStop);
  const timeout = AbortSignal.timeout(state.limits.modelCallTimeoutMs);
  const signal = state.signal === undefined ? timeout : AbortSignal.any([state.signal, timeout]);
  let output: { readonly usage?: unknown; readonly claims?: unknown; readonly outcome?: unknown } | null;
  let onAbort = (): void => undefined;
  // Set once the call is made: an abort before it sends nothing and costs nothing.
  let started = false;
  try {
    signal.throwIfAborted();
    started = true;
    // Rejects once the signal aborts, so a model that ignores its signal cannot hang the run.
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // The async wrapper turns a synchronous throw into a rejection, so `aborted` always has its handler.
    output = await Promise.race([(async () => model.extract(input, signal))(), aborted]);
  } catch (error) {
    if (state.signal?.aborted) {
      if (started) chargeUnanswered(state, inputBytes);
      return null;
    }
    const modelError = error instanceof BrainModelError ? error : null;
    if (timeout.aborted || modelError?.code === "model_timeout") {
      chargeUnanswered(state, inputBytes);
      return { status: "failed", errorCode: "model_timeout" };
    }
    if (modelError !== null) {
      // An answer lost on its way back may still be billed, whatever the code does next.
      if (modelError.unanswered) chargeUnanswered(state, inputBytes);
      if (modelError.code === "model_rejected") {
        state.stopAfter = modelError;
        return { status: "failed", errorCode: "model_failed" };
      }
      throw new ExtractionStop(modelError.code, { cause: error });
    }
    logFailure("model call failed", error, "model_failed");
    return { status: "failed", errorCode: "model_failed" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  // Cost unknown: charge the call's worst case, since it may still be billed, and fail the run closed.
  const usage = BrainExtractionUsageSchema.safeParse(output?.usage);
  if (!usage.success) {
    chargeUnanswered(state, inputBytes);
    throw new ExtractionStop("model_usage_invalid", { cause: usage.error });
  }
  for (const key of USAGE_KEYS) state.usage[key] += usage.data[key];
  // After the usage, so a billed refusal or unusable response is still counted.
  const outcome = BrainClaimModelOutcomeSchema.optional().safeParse(output?.outcome);
  if (!outcome.success || outcome.data?.status === "invalid") {
    return { status: "failed", errorCode: "model_output_invalid" };
  }
  if (outcome.data?.status === "skipped") return { status: "skipped", errorCode: outcome.data.code };
  const verified = verifyModelClaims({
    documentId: document.documentId, text, candidates: output?.claims, kinds: input.kinds, maxClaims: input.maxClaims,
  });
  if (verified === null) return { status: "failed", errorCode: "model_output_invalid" };
  state.counts.claimsRejected += verified.claimsRejected;
  state.counts.quotesRejected += verified.quotesRejected;
  return { status: "done", claims: verified.claims };
}

/** False when the document was revised or deleted since it was read: a live newer revision stays pending. */
async function applyOutcome(
  state: Extraction, document: BrainDocument, outcome: BrainDocumentExtractionOutcome,
): Promise<boolean> {
  const { documentId, incarnation, revision } = document;
  let result: BrainApplyDocumentExtractionResult;
  try {
    // The run's cost so far rides along, so the row keeps it even if this run never closes.
    result = await state.store.applyDocumentExtraction(state.scope, {
      runId: state.runId, documentId, incarnation, revision, extractor: state.extractor, outcome,
      runCostMicroUsd: state.usage.costMicroUsd,
    });
  } catch (error) {
    const code = error instanceof BrainStoreError ? error.code : null;
    if (outcome.status === "done" && (code === "invalid" || refusedByPostgres(error))) {
      logFailure("store refused claims", error, "claim_invalid");
      return applyOutcome(state, document, { status: "failed", errorCode: "claim_invalid" });
    }
    const stop = code === "capacity" ? "claims_capacity" : code === "conflict" ? "run_superseded" : "store_unavailable";
    throw new ExtractionStop(stop, { cause: error });
  }
  if (!result.applied) return false;
  state.counts.documentsProcessed += 1;
  if (outcome.status === "failed") state.counts.documentsFailed += 1;
  state.counts.claimsWritten += result.written;
  state.counts.claimsRemoved += result.removed;
  return true;
}

function budgetExhausted(state: Extraction, byteCount: number): boolean {
  const { limits, usage } = state;
  if (state.signal?.aborted || state.now() - state.startedAt >= limits.runBudgetMs) return true;
  if (state.bytesRead > 0 && state.bytesRead + byteCount > limits.bodyBytesPerRun) return true;
  return state.model !== undefined && (usage.inputTokens + usage.outputTokens >= limits.tokensPerRun
    || usage.costMicroUsd >= limits.costMicroUsdPerRun);
}

/** Whether pending documents are left: past this run's page, or kept by a budget, an abort or a revision race. */
async function processPending(state: Extraction): Promise<boolean> {
  const { limits, model, provenances } = state;
  if (provenances?.length === 0) return false;
  const page = await state.store.listPendingExtractions(state.scope, {
    extractor: state.extractor, limit: limits.documentsPerRun, maxAttempts: limits.maxAttempts,
    order: model === undefined ? "oldest" : "newest", ...(provenances === undefined ? {} : { provenances }),
  }).catch(unavailable);
  let left = page.hasMore;
  for (const item of page.items) {
    if (budgetExhausted(state, item.byteCount)) return true;
    const document = await state.store.getDocument(state.scope, item.documentId).catch(unavailable);
    // Gone, or moved on since the listing: a live newer revision is pending again for the next run.
    const moved = document?.deletedAt !== null || document.incarnation !== item.incarnation;
    if (moved || document.revision !== item.revision) {
      left ||= document !== null && document.deletedAt === null;
      continue;
    }
    state.bytesRead += document.byteCount;
    // The listing already filters by provenance; a store that did not is never trusted with what leaves the gateway.
    const sendable = model === undefined || MODEL_SENDABLE.has(document.provenance);
    const outcome = !sendable || (provenances !== undefined && !provenances.includes(document.provenance)) ? NOT_ALLOWED
      : model === undefined ? rulesOutcome(state, document) : await modelOutcome(state, model, document);
    if (outcome === null) return true;
    left = !(await applyOutcome(state, document, outcome)) || left;
    // Only model_rejected is kept for after its document: a request the API refuses must not fail a whole page.
    if (state.stopAfter !== null) throw new ExtractionStop("model_rejected", { cause: state.stopAfter });
  }
  return left;
}

async function runOpened(state: Extraction): Promise<BrainExtractionResult> {
  let failure: BrainExtractionErrorCode | null = null;
  let left = false;
  try {
    state.startedAt = state.now();
    if (state.model !== undefined) state.spend = await readBrainModelSpend(state.store, state.scope).catch(unavailable);
    left = await processPending(state);
  } catch (error) {
    failure = error instanceof ExtractionStop ? error.code : "internal_error";
    logFailure("extraction stopped", error instanceof ExtractionStop ? error.cause : error, failure);
  }
  const { counts, usage } = state;
  const status = failure !== null ? "failed" : counts.documentsFailed > 0 ? "partial" : "succeeded";
  const caughtUp = failure === null && !left;
  const nextAction: BrainExtractionNextAction = failure !== null ? NEXT_ACTIONS[failure]
    : !caughtUp ? "run_again" : counts.documentsFailed > 0 ? "retry_later" : "";
  const { runId } = state;
  const close: BrainCloseExtractionRunInput = { runId, status, counts, usage, nextAction, errorCode: failure };
  let run: BrainExtractionRun | null = null;
  try {
    run = await state.store.closeExtractionRun(state.scope, close);
  } catch (error) {
    logFailure("run close failed", error, "store_unavailable");
  }
  const spend = state.spend === null ? {}
    : { spend: brainModelSpendView(state.spend, state.limits.spendMicroUsdPer30d, usage.costMicroUsd) };
  return { status, errorCode: failure, nextAction, extractor: state.extractor, run, counts, usage, caughtUp, ...spend };
}

/**
 * Extracts claims for up to limits.documentsPerRun pending documents of one scope. nextAction "run_again": more
 * documents are pending; "retry_later": some failed and are retried until limits.maxAttempts. Never rejects.
 */
export async function runBrainExtraction(options: BrainExtractionOptions): Promise<BrainExtractionResult> {
  const extraction = parseOptions(options);
  if ("errorCode" in extraction) return extraction;
  const key = JSON.stringify([extraction.scope.ownerId, extraction.scope.scopeId]);
  const paid = extraction.model !== undefined;
  if (runningExtractions.has(key) || runningExtractions.size >= BRAIN_EXTRACTION_MAX_CONCURRENT_RUNS
    || (paid && runningModelOwners.has(extraction.scope.ownerId))) {
    return early("extraction_in_progress", extraction.extractor);
  }
  runningExtractions.add(key);
  if (paid) runningModelOwners.add(extraction.scope.ownerId);
  try {
    try {
      const { store, scope, extractor, admit } = extraction;
      const opened = await store.openExtractionRun(scope, { extractor }, admit);
      extraction.runId = opened.runId;
    } catch (error) {
      const conflict = error instanceof BrainStoreError && error.code === "conflict";
      if (!conflict) logFailure("run open failed", error, "store_unavailable");
      return early(conflict ? "extraction_in_progress" : "store_unavailable", extraction.extractor);
    }
    return await runOpened(extraction);
  } finally {
    runningExtractions.delete(key);
    if (paid) runningModelOwners.delete(extraction.scope.ownerId);
  }
}
