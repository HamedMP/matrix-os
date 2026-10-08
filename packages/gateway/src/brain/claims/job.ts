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
import { BrainClaimModelOutcomeSchema, BrainModelError } from "./model/types.js";
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
    now: options.now ?? Date.now, runId: "", startedAt: 0, bytesRead: 0, stopAfter: null, spend: null, ...zero(),
  };
}
