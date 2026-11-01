/**
 * Claims over the project API: one bounded extraction run per call (rules, or the configured model) and the claim list
 * of a project scope. Document body tails (used only to label pull requests and commits) never leave this module.
 */
import {
  BRAIN_MODEL_PROVENANCES, runBrainExtraction, type BrainClaimListItem, type BrainExtractionOptions,
  type BrainExtractionRun,
} from "../claims/index.js";
import { brainModelSpendView, readBrainModelSpend } from "../claims/spend.js";
import { brainCiteLabel } from "../cite.js";
import type { BrainScopeKey } from "../types.js";
import { normalizeBrainWhyPath } from "../why.js";
import {
  BRAIN_REQUEST_EXTRACTION_LIMITS, type BrainClaimDocumentKind, type BrainClaimView, type BrainExtractionRunView,
} from "./claims-types.js";
import { BrainApiError, type BrainProjectService, type BrainProjectServiceDeps } from "./types.js";

type ResolveProject = (ownerId: string, projectRef: string) => Promise<{ readonly scope: BrainScopeKey }>;

const DOCUMENT_KINDS: Readonly<Record<string, BrainClaimDocumentKind>> =
  { git_pr: "pr", git_commit: "commit", git_spec: "spec" };

/** The scope id stays inside the gateway. */
function toRunView(run: BrainExtractionRun): BrainExtractionRunView {
  const { runId, extractor, status, counts, usage, nextAction, errorCode, startedAt, finishedAt } = run;
  return { runId, extractor, status, counts, usage, nextAction, errorCode, startedAt, finishedAt };
}

/**
 * Pull requests and commits follow the shared cite rule (`#N` / `!N`, else the short sha of the footer in the body
 * tail, else "PR" / "commit"); spec and document labels are the title (no refs are read here).
 */
function documentLabel(document: BrainClaimListItem["document"], kind: BrainClaimDocumentKind): string {
  if (kind !== "pr" && kind !== "commit") return document.title;
  // The store returns a body tail for every pull request and commit.
  const { provenance, title, bodyTail } = document;
  return brainCiteLabel({ provenance, title, bodyTail, handle: null, spec: null });
}

function toClaimView({ claim, document }: BrainClaimListItem): BrainClaimView {
  const known = Object.hasOwn(DOCUMENT_KINDS, document.provenance);
  const kind = known ? DOCUMENT_KINDS[document.provenance]! : "document";
  return {
    claimId: claim.claimId, kind: claim.kind, label: claim.label, statement: claim.statement, quote: claim.quote,
    spanStart: claim.spanStart, spanEnd: claim.spanEnd, fields: claim.fields, confidence: claim.confidence,
    extractor: claim.extractor, revision: claim.revision, stale: claim.stale, createdAt: claim.createdAt,
    document: {
      documentId: document.documentId, kind, label: documentLabel(document, kind),
      title: document.title, permalink: document.permalink, date: document.sourceUpdatedAt,
      revision: document.revision,
    },
  };
}

export function createClaimMethods(
  deps: BrainProjectServiceDeps,
  resolveProject: ResolveProject,
): Pick<BrainProjectService, "extract" | "listClaims"> {
  const runExtraction = deps.extract ?? runBrainExtraction;
  const limits = deps.extractionLimits ?? BRAIN_REQUEST_EXTRACTION_LIMITS;
  const rules = { kind: "rules" } as const;

  /** Whether this principal may spend the gateway owner's model key (deps.modelOwnerIds; absent: everyone). */
  const mayUseModel = (ownerId: string): boolean =>
    deps.modelOwnerIds === undefined || deps.modelOwnerIds.includes(ownerId);

  /**
   * The model, its extractor identity and limits, resolved per request (the credential is read each time and never
   * kept). No provider, none configured, or a principal that is not the gateway owner: 409. A provider that cannot
   * read the owner's config rejects (503). Only documents synced from the owner's git source are sent to the model.
   */
  async function modelOptions(scope: BrainScopeKey): Promise<Omit<BrainExtractionOptions, "repository">> {
    if (!mayUseModel(scope.ownerId)) throw new BrainApiError("extractor_not_configured");
    const resolved = deps.claimModels === undefined ? null : await deps.claimModels();
    if (resolved === null) throw new BrainApiError("extractor_not_configured");
    const { model, modelId, promptVersion, limits: modelLimits } = resolved;
    return {
      scope, extractor: { kind: "model", modelId, promptVersion }, model, limits: modelLimits,
      provenances: BRAIN_MODEL_PROVENANCES,
    };
  }

  return {
    async extract(ownerId, projectRef, input, signal) {
      const { scope } = await resolveProject(ownerId, projectRef);
      const options = input.extractor === "model" ? await modelOptions(scope) : { scope, extractor: rules, limits };
      // One run per request; the client repeats on run_again. No git source is required.
      const result = await runExtraction({
        repository: deps.repository, ...options, ...(signal === undefined ? {} : { signal }),
      });
      // Failures that ended before a run row existed are the only extraction outcomes that are not a 200.
      if (result.run === null && result.status === "failed") {
        if (result.errorCode === "extraction_in_progress") throw new BrainApiError("extraction_in_progress");
        console.error("[brain-api] extraction could not record a run:", result.errorCode);
        throw new BrainApiError("brain_unavailable");
      }
      return { ...result, run: result.run === null ? null : toRunView(result.run) };
    },

    async listClaims(ownerId, projectRef, query) {
      const { scope } = await resolveProject(ownerId, projectRef);
      const normalized = query.path === undefined ? null : normalizeBrainWhyPath(query.path);
      if (query.path !== undefined && normalized === null) throw new BrainApiError("invalid_request");
      const path = normalized === null ? undefined : {
        value: normalized.path, mode: normalized.match === "folder" ? "under" as const : "exact_or_under" as const,
      };
      const page = await deps.repository.listClaims(scope,
        { kind: query.kind, path, limit: query.limit, cursor: query.cursor ?? null });
      // The window a model run checks; a read failure rejects like the page read (503).
      const cap = mayUseModel(ownerId) ? deps.modelSpendCapMicroUsd : undefined;
      const spend = cap === undefined ? null : await readBrainModelSpend(deps.repository, scope);
      return {
        kind: query.kind ?? null, path: normalized?.path ?? null, match: normalized?.match ?? null,
        items: page.items.map(toClaimView), nextCursor: page.nextCursor,
        modelSpend: cap === undefined || spend === null ? null : brainModelSpendView(spend, cap, 0),
      };
    },
  };
}
