/**
 * Company Brain ref matching: live documents whose refs of one kind equal or sit under a value. Re-exported by
 * types.ts, so importers keep using "./types.js".
 */
import type { BrainDocument, BrainDocumentRef } from "./types.js";

export const BRAIN_REF_MATCH_DEFAULT_LIMIT = 10;
export const BRAIN_REF_MATCH_MAX_LIMIT = 50;
export const BRAIN_REF_MATCH_COUNT_CAP = 1_000;
export const BRAIN_REF_MATCH_MAX_PROVENANCES = 8;
export const BRAIN_REF_MATCH_MAX_EXTRA_KINDS = 4;

/** exact_or_under: the value itself or anything starting with value + "/". under: only the latter. */
export type BrainRefMatchMode = "exact_or_under" | "under";

/**
 * kind: a ref kind such as "path". value: opaque, 1..512 utf8 bytes, no NUL, by convention without a trailing "/".
 * provenances: only live documents with one of these (1..8, unique). extraRefKinds: ref kinds also returned per item
 * (0..4, unique), e.g. ["spec"].
 */
export interface BrainRefMatchQuery {
  readonly kind: string; readonly value: string; readonly mode: BrainRefMatchMode;
  readonly provenances: readonly string[]; readonly extraRefKinds?: readonly string[];
  readonly limit?: number; readonly cursor?: string | null;
}

export interface BrainRefMatch {
  readonly document: BrainDocument;
  /** Matching refs of the query kind, then every ref of extraRefKinds; by kind, value; at most BRAIN_DOCUMENT_REFS_MAX. */
  readonly refs: readonly BrainDocumentRef[];
}

/** Newest source_updated_at first, then document id; total is min(matches, BRAIN_REF_MATCH_COUNT_CAP) on every page. */
export interface BrainRefMatchPage {
  readonly items: readonly BrainRefMatch[]; readonly nextCursor: string | null; readonly total: number;
  readonly totalCapped: boolean;
}
