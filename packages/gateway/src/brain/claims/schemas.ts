/**
 * Company Brain claim store input schemas. The repository parses every claim, extraction and run input here before
 * any SQL runs; bounds come from claims/types.ts and are mirrored by the CHECK constraints in claims/database.ts.
 */
import { z } from "zod/v4";
import { BrainDocumentIdSchema, BrainDocumentRefSchema } from "../schemas.js";
import { BRAIN_ERROR_CODE_PATTERN, BRAIN_KIND_PATTERN, BRAIN_MAX_REVISION, BRAIN_NEXT_ACTION_MAX_CHARS } from "../types.js";
import {
  BRAIN_CLAIM_CONFIDENCES, BRAIN_CLAIM_ID_PATTERN, BRAIN_CLAIM_KINDS, BRAIN_CLAIM_LABEL_MAX_CHARS,
  BRAIN_CLAIM_LIST_CURSOR_MAX_CHARS, BRAIN_CLAIM_LIST_DEFAULT_LIMIT, BRAIN_CLAIM_LIST_MAX_LIMIT,
  BRAIN_CLAIM_QUOTE_MAX_CHARS, BRAIN_CLAIM_SPAN_MAX, BRAIN_CLAIM_STATEMENT_MAX_CHARS, BRAIN_CLAIMS_PER_DOCUMENT_MAX,
  BRAIN_EXTRACTION_LIMIT_CEILINGS, BRAIN_EXTRACTION_RUN_ID_PATTERN, BRAIN_EXTRACTOR_ID_MAX_CHARS,
  BRAIN_EXTRACTOR_ID_PATTERN, BrainClaimFieldsSchema, computeBrainClaimId, noControl, noNul,
} from "./types.js";

/** Run counters and usage totals are INTEGER columns. */
const RUN_COUNT_MAX = 2_147_483_647;
/** Provenances one pending listing may filter on. */
const BRAIN_PENDING_PROVENANCES_MAX = 16;
const NEXT_ACTION_PATTERN = /^(?:[a-z][a-z0-9_]*)?$/;

/** A lone surrogate cannot round-trip through Postgres TEXT or JSONB, so text must be well-formed UTF-16. */
const wellFormed = (value: string): boolean => value.isWellFormed();
const collapsed = (value: string): boolean => value === value.replace(/\s+/gu, " ").trim();
const runCount = z.number().int().min(0).max(RUN_COUNT_MAX);

export const BrainClaimIdSchema = z.string().regex(BRAIN_CLAIM_ID_PATTERN);
export const BrainExtractionRunIdSchema = z.string().regex(BRAIN_EXTRACTION_RUN_ID_PATTERN);
export const BrainExtractorIdSchema = z.string().max(BRAIN_EXTRACTOR_ID_MAX_CHARS).regex(BRAIN_EXTRACTOR_ID_PATTERN);

/** One claim as the store accepts it; the span must cover exactly the quote's UTF-16 units. */
export const BrainClaimInputSchema = z.object({
  claimId: BrainClaimIdSchema, kind: z.enum(BRAIN_CLAIM_KINDS),
  label: z.string().min(1).max(BRAIN_CLAIM_LABEL_MAX_CHARS).refine(noControl).refine(wellFormed).nullable(),
  statement: z.string().min(1).max(BRAIN_CLAIM_STATEMENT_MAX_CHARS).refine(noControl).refine(wellFormed)
    .refine(collapsed),
  quote: z.string().min(1).max(BRAIN_CLAIM_QUOTE_MAX_CHARS).refine(noNul).refine(wellFormed),
  spanStart: z.number().int().min(0).max(BRAIN_CLAIM_SPAN_MAX - 1),
  spanEnd: z.number().int().min(1).max(BRAIN_CLAIM_SPAN_MAX),
  fields: BrainClaimFieldsSchema,
  confidence: z.enum(BRAIN_CLAIM_CONFIDENCES),
}).strict().refine((claim) => claim.spanEnd - claim.spanStart === claim.quote.length);

const DocumentOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), claims: z.array(BrainClaimInputSchema).max(BRAIN_CLAIMS_PER_DOCUMENT_MAX) })
    .strict(),
  z.object({ status: z.enum(["failed", "skipped"]), errorCode: z.string().regex(BRAIN_ERROR_CODE_PATTERN) }).strict(),
]);

/** Claim ids are unique and each is the id of its own (document, kind, label, statement). */
export const BrainApplyDocumentExtractionSchema = z.object({
  runId: BrainExtractionRunIdSchema, documentId: BrainDocumentIdSchema, incarnation: z.uuid(),
  revision: z.number().int().min(1).max(BRAIN_MAX_REVISION), extractor: BrainExtractorIdSchema,
  outcome: DocumentOutcomeSchema, runCostMicroUsd: runCount.default(0),
}).strict().refine((input) => {
  if (input.outcome.status !== "done") return true;
  const ids = input.outcome.claims.map((claim) => claim.claimId);
  return ids.every((id, index) => ids.indexOf(id) === index)
    && input.outcome.claims.every((claim) =>
      claim.claimId === computeBrainClaimId(input.documentId, claim.kind, claim.label, claim.statement));
});
export type BrainParsedApplyDocumentExtraction = z.output<typeof BrainApplyDocumentExtractionSchema>;

export const BrainPendingExtractionQuerySchema = z.object({
  extractor: BrainExtractorIdSchema,
  limit: z.number().int().min(1).max(BRAIN_EXTRACTION_LIMIT_CEILINGS.documentsPerRun),
  maxAttempts: z.number().int().min(1).max(BRAIN_EXTRACTION_LIMIT_CEILINGS.maxAttempts),
  order: z.enum(["oldest", "newest"]).default("oldest"),
  provenances: z.array(z.string().regex(BRAIN_KIND_PATTERN)).min(1).max(BRAIN_PENDING_PROVENANCES_MAX).optional(),
}).strict();

export const BrainOpenExtractionRunSchema = z.object({ extractor: BrainExtractorIdSchema }).strict();

export const BrainCloseExtractionRunSchema = z.object({
  runId: BrainExtractionRunIdSchema,
  status: z.enum(["succeeded", "partial", "failed"]),
  counts: z.object({
    documentsProcessed: runCount, documentsFailed: runCount, claimsWritten: runCount,
    claimsRemoved: runCount, claimsRejected: runCount, quotesRejected: runCount,
  }).strict(),
  usage: z.object({
    inputTokens: runCount, outputTokens: runCount, costMicroUsd: runCount,
    cacheReadTokens: runCount.default(0), cacheWriteTokens: runCount.default(0),
  }).strict(),
  nextAction: z.string().max(BRAIN_NEXT_ACTION_MAX_CHARS).regex(NEXT_ACTION_PATTERN),
  errorCode: z.string().regex(BRAIN_ERROR_CODE_PATTERN).nullable(),
}).strict();
export type BrainParsedCloseExtractionRun = z.output<typeof BrainCloseExtractionRunSchema>;

/** The cursor is opaque here and decoded strictly by claims/reads.ts. */
export const BrainClaimListQuerySchema = z.object({
  kind: z.enum(BRAIN_CLAIM_KINDS).optional(),
  path: z.object({ value: BrainDocumentRefSchema.shape.value, mode: z.enum(["exact_or_under", "under"]) }).strict()
    .optional(),
  limit: z.number().int().min(1).max(BRAIN_CLAIM_LIST_MAX_LIMIT).default(BRAIN_CLAIM_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(BRAIN_CLAIM_LIST_CURSOR_MAX_CHARS).refine(noNul).nullable().default(null),
}).strict();
export type BrainParsedClaimListQuery = z.output<typeof BrainClaimListQuerySchema>;
