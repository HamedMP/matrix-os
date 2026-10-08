/**
 * Company Brain store input schemas. Every repository input is parsed here
 * before any SQL runs: strict objects, bounded strings, bounded arrays,
 * integer numbers. Limits and patterns come from types.ts; the SQL CHECK
 * constraints in database.ts mirror the same values.
 */
import { z } from "zod/v4";
import {
  BRAIN_CURSOR_MAX_CHARS,
  BRAIN_DOCUMENT_ID_PATTERN,
  BRAIN_DOCUMENT_MAX_BYTES,
  BRAIN_DOCUMENT_REFS_MAX,
  BRAIN_ERROR_CODE_PATTERN,
  BRAIN_EVIDENCE_PROOFS_MAX,
  BRAIN_KIND_PATTERN,
  BRAIN_LIST_DEFAULT_LIMIT,
  BRAIN_LIST_MAX_LIMIT,
  BRAIN_MAX_REVISION,
  BRAIN_NEXT_ACTION_MAX_CHARS,
  BRAIN_OWNER_ID_MAX_CHARS,
  BRAIN_PERMALINK_MAX_CHARS,
  BRAIN_RECEIPT_ID_PATTERN,
  BRAIN_RECEIPTS_PER_SOURCE,
  BRAIN_REF_MATCH_DEFAULT_LIMIT,
  BRAIN_REF_MATCH_MAX_EXTRA_KINDS,
  BRAIN_REF_MATCH_MAX_LIMIT,
  BRAIN_REF_MATCH_MAX_PROVENANCES,
  BRAIN_REF_VALUE_MAX_BYTES,
  BRAIN_SCOPE_ID_MAX_CHARS,
  BRAIN_SEARCH_MAX_LIMIT,
  BRAIN_SEARCH_QUERY_MAX_CHARS,
  BRAIN_SOURCE_EXTERNAL_REF_MAX_CHARS,
  BRAIN_SOURCE_ID_PATTERN,
  BRAIN_SOURCE_LABEL_MAX_CHARS,
  BRAIN_SYNC_BATCH_MAX_ITEMS,
  BRAIN_SYNC_BATCH_MAX_REFS,
  BRAIN_TITLE_MAX_CHARS,
  BrainStoreError,
} from "./types.js";

const LIST_CURSOR_MAX_CHARS = 256;
const COUNT_MAX = 1_000_000_000;
const DEFAULT_SEARCH_LIMIT = 10;

/**
 * Operator hint vocabulary (`reconnect_slack`, `retry_after_backoff`), or
 * empty. Same shape as error codes so a raw provider message can never land in
 * a receipt. (A `BRAIN_NEXT_ACTION_PATTERN` in types.ts would be the cleaner home.)
 */
const NEXT_ACTION_PATTERN = /^(?:[a-z][a-z0-9_]*)?$/;

/**
 * Postgres rejects U+0000 in TEXT with a driver error (22021) that is not a
 * BrainStoreError, so every free-text field refuses it here instead.
 * Regex-bound fields (ids, kind, provenance, codes) already exclude it.
 */
const noNul = (value: string): boolean => !value.includes("\u0000");

const revisionSchema = z.number().int().min(1).max(BRAIN_MAX_REVISION);
const cursorTextSchema = z.string().min(1).max(BRAIN_CURSOR_MAX_CHARS).refine(noNul);
const kindSchema = z.string().regex(BRAIN_KIND_PATTERN);
const sourceStatusSchema = z.enum(["active", "paused", "disabled"]);
const countSchema = z.number().int().min(0).max(COUNT_MAX);
const labelSchema = z.string().min(1).max(BRAIN_SOURCE_LABEL_MAX_CHARS).refine(noNul);

/**
 * Empty, or an https URL without credentials in its canonical form: the value
 * must equal `new URL(value).href`, so surrounding whitespace, raw control
 * characters, an uppercase scheme or an un-normalised host are rejected rather
 * than stored verbatim and echoed back in citations.
 */
function isBrainPermalink(value: string): boolean {
  if (value === "") return true;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.href === value;
}

function withinDocumentByteLimit(content: { title: string; body: string }): boolean {
  return Buffer.byteLength(content.title, "utf8") + Buffer.byteLength(content.body, "utf8") <= BRAIN_DOCUMENT_MAX_BYTES;
}

function uniqueStrings(values: readonly string[]): boolean {
  return values.every((value, index) => values.indexOf(value) === index);
}

export const BrainScopeKeySchema = z.object({
  scopeId: z.string().min(1).max(BRAIN_SCOPE_ID_MAX_CHARS).refine(noNul),
  ownerId: z.string().min(1).max(BRAIN_OWNER_ID_MAX_CHARS).refine(noNul),
}).strict();

export const BrainSourceIdSchema = z.string().regex(BRAIN_SOURCE_ID_PATTERN);
export const BrainDocumentIdSchema = z.string().regex(BRAIN_DOCUMENT_ID_PATTERN);
export const BrainReceiptIdSchema = z.string().regex(BRAIN_RECEIPT_ID_PATTERN);

export const BrainCreateSourceSchema = z.object({
  kind: kindSchema,
  externalRef: z.string().min(1).max(BRAIN_SOURCE_EXTERNAL_REF_MAX_CHARS).refine(noNul),
  label: labelSchema,
  status: sourceStatusSchema.optional(),
}).strict();

export const BrainUpdateSourceSchema = z.object({
  sourceId: BrainSourceIdSchema,
  expectedRevision: revisionSchema,
  label: labelSchema.optional(),
  status: sourceStatusSchema.optional(),
}).strict().refine((input) => input.label !== undefined || input.status !== undefined);

export const BrainDeleteSourceSchema = z.object({
  sourceId: BrainSourceIdSchema,
  expectedRevision: revisionSchema,
}).strict();

const documentContentFields = {
  documentId: BrainDocumentIdSchema,
  title: z.string().trim().min(1).max(BRAIN_TITLE_MAX_CHARS).refine(noNul),
  body: z.string().min(1).refine(noNul),
  permalink: z.string().max(BRAIN_PERMALINK_MAX_CHARS).refine(noNul).refine(isBrainPermalink),
  sourceUpdatedAt: z.iso.datetime({ offset: true }),
  provenance: kindSchema,
};

export const BrainDocumentContentSchema = z.object(documentContentFields).strict().refine(withinDocumentByteLimit);

export const BrainDocumentRefSchema = z.object({
  kind: kindSchema,
  value: z.string().min(1).max(BRAIN_REF_VALUE_MAX_BYTES).refine(noNul)
    .refine((value) => Buffer.byteLength(value, "utf8") <= BRAIN_REF_VALUE_MAX_BYTES),
}).strict();

/** Sync upserts carry the document's complete ref set, unique by (kind, value). */
export const BrainSyncUpsertSchema = z.object({
  ...documentContentFields,
  refs: z.array(BrainDocumentRefSchema).max(BRAIN_DOCUMENT_REFS_MAX).default([]),
}).strict().refine(withinDocumentByteLimit)
  .refine((input) => uniqueStrings(input.refs.map((ref) => JSON.stringify([ref.kind, ref.value]))));

export const BrainUpsertDocumentSchema = z.object({
  ...documentContentFields,
  sourceId: BrainSourceIdSchema.nullable(),
  expectedRevision: z.number().int().min(0).max(BRAIN_MAX_REVISION).optional(),
}).strict().refine(withinDocumentByteLimit);

/** The combined byte limit is re-checked by the repository after merging with the stored row. */
export const BrainReviseDocumentSchema = z.object({
  documentId: BrainDocumentIdSchema,
  expectedRevision: revisionSchema,
  title: documentContentFields.title.optional(),
  body: documentContentFields.body.optional(),
  permalink: documentContentFields.permalink.optional(),
  sourceUpdatedAt: documentContentFields.sourceUpdatedAt.optional(),
}).strict().refine((input) =>
  input.title !== undefined || input.body !== undefined
  || input.permalink !== undefined || input.sourceUpdatedAt !== undefined);

export const BrainDeleteDocumentSchema = z.object({
  documentId: BrainDocumentIdSchema,
  expectedRevision: revisionSchema.optional(),
}).strict();

export const BrainSyncBatchSchema = z.object({
  sourceId: BrainSourceIdSchema,
  expectedCursor: cursorTextSchema.nullable(),
  nextCursor: cursorTextSchema,
  upserts: z.array(BrainSyncUpsertSchema).max(BRAIN_SYNC_BATCH_MAX_ITEMS),
  deletions: z.array(BrainDocumentIdSchema).max(BRAIN_SYNC_BATCH_MAX_ITEMS),
}).strict().refine((input) =>
  uniqueStrings(input.upserts.map((upsert) => upsert.documentId)) && uniqueStrings(input.deletions)
  && input.upserts.reduce((total, upsert) => total + upsert.refs.length, 0) <= BRAIN_SYNC_BATCH_MAX_REFS);

export const BrainOpenSyncReceiptSchema = z.object({ sourceId: BrainSourceIdSchema }).strict();

export const BrainCloseSyncReceiptSchema = z.object({
  sourceId: BrainSourceIdSchema,
  receiptId: BrainReceiptIdSchema,
  status: z.enum(["succeeded", "partial", "failed"]),
  counts: z.object({
    read: countSchema,
    written: countSchema,
    unchanged: countSchema,
    deleted: countSchema,
    failed: countSchema,
  }).strict(),
  nextAction: z.string().max(BRAIN_NEXT_ACTION_MAX_CHARS).regex(NEXT_ACTION_PATTERN).optional(),
  errorCode: z.string().regex(BRAIN_ERROR_CODE_PATTERN).nullable().optional(),
}).strict();

export const BrainListOptionsSchema = z.object({
  limit: z.number().int().min(1).max(BRAIN_LIST_MAX_LIMIT).default(BRAIN_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(LIST_CURSOR_MAX_CHARS).refine(noNul).nullable().default(null),
}).strict();

export const BrainListDocumentsOptionsSchema = BrainListOptionsSchema.extend({
  sourceId: BrainSourceIdSchema.optional(),
}).strict();

export const BrainListReceiptsOptionsSchema = z.object({
  limit: z.number().int().min(1).max(BRAIN_RECEIPTS_PER_SOURCE).default(BRAIN_RECEIPTS_PER_SOURCE),
}).strict();

export const BrainSearchSchema = z.object({
  query: z.string().trim().min(1).max(BRAIN_SEARCH_QUERY_MAX_CHARS).refine(noNul),
  limit: z.number().int().min(1).max(BRAIN_SEARCH_MAX_LIMIT).default(DEFAULT_SEARCH_LIMIT),
}).strict();

/** listDocumentsByRef: the cursor is opaque here and decoded strictly by refs-reads.ts. */
export const BrainRefMatchQuerySchema = z.object({
  kind: kindSchema,
  value: BrainDocumentRefSchema.shape.value,
  mode: z.enum(["exact_or_under", "under"]),
  provenances: z.array(kindSchema).min(1).max(BRAIN_REF_MATCH_MAX_PROVENANCES).refine(uniqueStrings),
  extraRefKinds: z.array(kindSchema).max(BRAIN_REF_MATCH_MAX_EXTRA_KINDS).refine(uniqueStrings).default([]),
  limit: z.number().int().min(1).max(BRAIN_REF_MATCH_MAX_LIMIT).default(BRAIN_REF_MATCH_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(LIST_CURSOR_MAX_CHARS).refine(noNul).nullable().default(null),
}).strict();

export const BrainEvidenceProofsSchema = z.array(z.object({
  documentId: BrainDocumentIdSchema,
  incarnation: z.uuid(),
  revision: revisionSchema,
}).strict()).max(BRAIN_EVIDENCE_PROOFS_MAX);

/** Parses or throws `BrainStoreError("invalid")`; Zod issues never leave the module. */
export function parseBrainInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BrainStoreError("invalid", { cause: result.error });
  }
  return result.data as z.output<S>;
}
