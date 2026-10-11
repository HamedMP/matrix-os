/**
 * Claims over the project API: the POST /extract and GET /claims shapes, their bounds, and the one-run-per-request
 * extraction limits. claims-service.ts builds these views; routes.ts validates the inputs.
 */
import type {
  BrainClaim, BrainClaimKind, BrainExtractionLimits, BrainExtractionResult, BrainExtractionRun, BrainModelSpend,
} from "../claims/types.js";
import type { BrainWhyMatch } from "./types.js";

export const BRAIN_EXTRACT_BODY_MAX_BYTES = 1024;

/**
 * One rules extraction run per request, well under the 300 s Node request timeout; the client repeats on run_again.
 * A model run uses the limits of its BrainClaimModelResolution instead.
 */
export const BRAIN_REQUEST_EXTRACTION_LIMITS: Partial<BrainExtractionLimits> = { documentsPerRun: 200, runBudgetMs: 20_000 };

/**
 * "model" runs the configured Claude extractor (spec 555); without a valid model configuration and credential it is
 * extractor_not_configured.
 */
export interface BrainExtractInput { readonly extractor: "rules" | "model" }

export type BrainExtractionRunView = Omit<BrainExtractionRun, "scopeId">;

/** One bounded runBrainExtraction run. A failed run that has a run row is still a 200 with this view. */
export type BrainExtractView = Omit<BrainExtractionResult, "run"> & { readonly run: BrainExtractionRunView | null };

/** From provenance: git_pr, git_commit, git_spec; anything else is a document. */
export type BrainClaimDocumentKind = "pr" | "commit" | "spec" | "document";

/**
 * label: `#12` or `!12` from the git footer (else `PR`), a 12-character sha (else `commit`), or the title.
 * permalink: canonical https link or "". date: ISO-8601 source_updated_at. revision: the live revision.
 */
export interface BrainClaimDocumentView {
  readonly documentId: string; readonly kind: BrainClaimDocumentKind; readonly label: string;
  readonly title: string; readonly permalink: string; readonly date: string; readonly revision: number;
}

/**
 * quote equals the document body from spanStart to spanEnd (UTF-16 units) at `revision`, the revision the claim was
 * read from. stale: the live document has moved to another revision or incarnation since.
 */
export type BrainClaimView = Omit<BrainClaim, "documentId" | "incarnation"> & { readonly document: BrainClaimDocumentView };

/** path: repo-relative file or folder; one trailing "/" means folder only (as brain_why). cursor: opaque. */
export interface BrainClaimsQuery {
  readonly kind?: BrainClaimKind; readonly path?: string; readonly limit: number; readonly cursor?: string;
}

/**
 * Newest document first, then document id; within a document by span, claim id and extractor. path: normalized (no
 * trailing "/"), null without a path filter. modelSpend: the scope's model extraction spend over the last 30 days
 * against its cap (the same window a model run checks), so a client can show the budget before a run; null when the
 * gateway has no model extractor settings.
 */
export interface BrainClaimsView {
  readonly kind: BrainClaimKind | null; readonly path: string | null; readonly match: BrainWhyMatch | null;
  readonly items: readonly BrainClaimView[]; readonly nextCursor: string | null;
  readonly modelSpend: BrainModelSpend | null;
}
