/**
 * Owner-scoped project brain. Resolves a Matrix project of the caller to its
 * personal brain scope and checkout, registers the project's git source, runs
 * exactly one bounded sync per call, lists receipts and answers brain_why;
 * claims-service.ts adds claim extraction and the claim list.
 * Holds no timers, caches or connections, so there is nothing to tear down.
 */
import type { Kysely } from "kysely";
import type { ProjectConfig } from "../../project-manager.js";
import { createBrainClaimModelProvider, parseBrainModelConfig } from "../claims/model/config.js";
import { GIT_SOURCE_KIND, parseWebBase, syncGitSource, type GitSyncResult } from "../git/index.js";
import {
  BRAIN_SOURCE_LABEL_MAX_CHARS, BrainRepository, type BrainDatabase, type BrainScopeKey, type BrainSource,
  type BrainSyncReceipt,
} from "../index.js";
import { brainWhy, normalizeBrainWhyPath } from "../why.js";
import { createClaimMethods } from "./claims-service.js";
import { lookupBrainProject } from "./project-resolver.js";
import {
  BRAIN_PROJECT_IDENTITY_PREFIX, BRAIN_REQUEST_SYNC_LIMITS, BRAIN_SOURCES_SCAN_LIMIT, BrainApiError,
  type BrainGitSourceView, type BrainProjectService, type BrainProjectServiceDeps, type BrainReceiptView,
  type BrainSyncView, type BrainWhyLastSync,
} from "./types.js";

/** Postgres lock_timeout and statement_timeout codes. */
const BOOTSTRAP_DEADLINE_CODES: ReadonlySet<unknown> = new Set(["55P03", "57014"]);

/** The deadline code of a bootstrap error that defers the brain, else null (any other error fails startup). */
export function brainBootstrapDeadlineCode(error: unknown): string | null {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && BOOTSTRAP_DEADLINE_CODES.has(code) ? code : null;
}

interface ResolvedProject {
  readonly project: ProjectConfig;
  readonly scope: BrainScopeKey;
}

function toSourceView({ sourceId, label, externalRef, status, createdAt, updatedAt }: BrainSource): BrainGitSourceView {
  return { sourceId, label, externalRef, webBase: parseWebBase(externalRef)?.href ?? null, status, createdAt, updatedAt };
}

function toReceiptView(receipt: BrainSyncReceipt): BrainReceiptView {
  const { receiptId, status, counts, nextAction, errorCode, startedAt, finishedAt } = receipt;
  return { receiptId, status, counts, nextAction, errorCode, startedAt, finishedAt };
}

function toLastSync(receipt: BrainSyncReceipt | undefined): BrainWhyLastSync | null {
  if (receipt === undefined) return null;
  const { status, startedAt, finishedAt, nextAction, errorCode } = receipt;
  return { status, startedAt, finishedAt, nextAction, errorCode };
}

function toSyncView(result: GitSyncResult): BrainSyncView {
  const { status, errorCode, nextAction, caughtUp, commitsProcessed, commitsRemaining, counts, notices } = result;
  const receipt = result.receipt === null ? null : toReceiptView(result.receipt);
  return { status, errorCode, nextAction, caughtUp, commitsProcessed, commitsRemaining, counts, notices, receipt };
}

/** Project name without NUL, trimmed and cut to the store's label bound; the slug when nothing is left. */
function sourceLabel(project: ProjectConfig): string {
  let label = project.name.replaceAll("\u0000", "").trim().slice(0, BRAIN_SOURCE_LABEL_MAX_CHARS);
  if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1);
  label = label.trimEnd();
  return label.length > 0 ? label : project.slug;
}

/** The oldest live git source wins when a registration race left more than one. */
function isOlder(candidate: BrainSource, current: BrainSource): boolean {
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt < current.createdAt;
  return candidate.sourceId < current.sourceId;
}

/** Failures that ended before a receipt existed: the only sync outcomes that are not a 200. */
function receiptlessFailure(result: GitSyncResult): BrainApiError {
  switch (result.errorCode) {
    case "sync_in_progress":
      return new BrainApiError("sync_in_progress");
    case "source_unavailable":
    case "source_inactive":
    case "source_kind_mismatch":
      return new BrainApiError("git_source_unavailable");
    default:
      console.error("[brain-api] sync could not record a receipt:", result.errorCode);
      return new BrainApiError("brain_unavailable");
  }
}

export function createBrainProjectService(deps: BrainProjectServiceDeps): BrainProjectService {
  const runSync = deps.sync ?? syncGitSource;
  const syncLimits = deps.syncLimits ?? BRAIN_REQUEST_SYNC_LIMITS;

  /** Missing, foreign, archived, deleting and malformed projects are the same not-found (project-resolver.ts). */
  function resolveProject(ownerId: string, projectRef: string): Promise<ResolvedProject> {
    return lookupBrainProject(deps.projects, ownerId, projectRef);
  }

  async function findGitSource(scope: BrainScopeKey): Promise<BrainSource | null> {
    const page = await deps.repository.listSources(scope, { limit: BRAIN_SOURCES_SCAN_LIMIT });
    let found: BrainSource | null = null;
    for (const source of page.items) {
      if (source.kind !== GIT_SOURCE_KIND) continue;
      if (found === null || isOlder(source, found)) found = source;
    }
    return found;
  }

  return {
    async registerGitSource(ownerId, projectRef, input) {
      const { project, scope } = await resolveProject(ownerId, projectRef);
      if (input.webBase !== undefined && parseWebBase(input.webBase) === null) {
        throw new BrainApiError("invalid_request");
      }
      const existing = await findGitSource(scope);
      if (existing !== null) {
        if (input.webBase !== undefined && input.webBase !== existing.externalRef) {
          throw new BrainApiError("git_source_conflict");
        }
        return { source: toSourceView(existing), created: false };
      }
      // No git process runs here: a `project:<id>` source takes its web base from origin on every run.
      const githubBase = project.github?.htmlUrl ? parseWebBase(project.github.htmlUrl) : null;
      const externalRef = input.webBase ?? githubBase?.href ?? `${BRAIN_PROJECT_IDENTITY_PREFIX}${project.id}`;
      // The project is resolved again under the scope lock, so a project deleted since gets no source after its erase.
      const result = await deps.repository.createSource(scope, {
        kind: GIT_SOURCE_KIND,
        externalRef,
        label: sourceLabel(project),
      }, undefined, () => resolveProject(ownerId, project.id));
      return { source: toSourceView(result.source), created: result.created };
    },

    async sync(ownerId, projectRef, run = {}) {
      const { project, scope } = await resolveProject(ownerId, projectRef);
      const source = await findGitSource(scope);
      if (source === null) throw new BrainApiError("git_source_missing");
      // Never another source under the id the caller named (a race may have removed that one since it looked).
      if (run.sourceId !== undefined && run.sourceId !== source.sourceId) throw new BrainApiError("git_source_conflict");
      const repoPath = await deps.projects.resolveProjectWorkingDirectory(project);
      if (repoPath === null) throw new BrainApiError("checkout_unavailable");
      // One run per request, same config on every run (spec 552); the client repeats on run_again.
      const result = await runSync({
        repository: deps.repository,
        scope,
        sourceId: source.sourceId,
        repoPath,
        homePath: deps.homePath,
        config: {},
        limits: syncLimits,
        ...(run.signal === undefined ? {} : { signal: run.signal }),
      });
      if (result.receipt === null && result.status === "failed") throw receiptlessFailure(result);
      return toSyncView(result);
    },

    async listReceipts(ownerId, projectRef, limit) {
      const { scope } = await resolveProject(ownerId, projectRef);
      const source = await findGitSource(scope);
      if (source === null) return { source: null, receipts: [] };
      const receipts = await deps.repository.listSyncReceipts(scope, source.sourceId, { limit });
      return { source: toSourceView(source), receipts: receipts.map(toReceiptView) };
    },

    async why(ownerId, projectRef, query) {
      const { scope } = await resolveProject(ownerId, projectRef);
      const source = await findGitSource(scope);
      if (source === null) {
        const normalized = normalizeBrainWhyPath(query.path);
        if (normalized === null) throw new BrainApiError("invalid_request");
        return {
          path: normalized.path,
          match: normalized.match,
          detail: query.detail ?? "brief",
          total: 0,
          totalCapped: false,
          items: [],
          nextCursor: null,
          source: null,
        };
      }
      const [page, receipts] = await Promise.all([
        brainWhy(deps.repository, scope, query),
        deps.repository.listSyncReceipts(scope, source.sourceId, { limit: 1 }),
      ]);
      return {
        ...page,
        source: {
          sourceId: source.sourceId,
          webBase: parseWebBase(source.externalRef)?.href ?? null,
          lastSync: toLastSync(receipts[0]),
        },
      };
    },

    ...createClaimMethods(deps, resolveProject),
  };
}

/**
 * Builds the store on the shared owner Kysely and bootstraps it. A lock or statement deadline defers the brain
 * (null, logged as deferred; the next start retries). Any other error propagates to the caller: startBrainServices
 * (api/start.ts) catches it and leaves the brain off, so a brain failure never takes down owner startup (chats,
 * canvas, messaging). Model claim extraction gets the Anthropic provider (configuration from the environment,
 * credential read per request).
 */
export async function startBrainProjectService(
  kysely: Kysely<BrainDatabase>,
  deps: Omit<BrainProjectServiceDeps, "repository">,
): Promise<BrainProjectService | null> {
  const repository = new BrainRepository(kysely);
  try {
    await repository.bootstrap();
  } catch (error: unknown) {
    const code = brainBootstrapDeadlineCode(error);
    if (code === null) throw error;
    console.warn("[brain] bootstrap deferred after a database deadline:", code);
    return null;
  }
  if (deps.claimModels !== undefined) return createBrainProjectService({ ...deps, repository });
  // The default provider's cap, which its runs enforce; an invalid setting turns the model off (no cap shown).
  const parsed = parseBrainModelConfig(process.env);
  const claimModels = createBrainClaimModelProvider({ homePath: deps.homePath, env: process.env });
  return createBrainProjectService({
    ...deps, repository, claimModels,
    ...(parsed.ok && deps.modelSpendCapMicroUsd === undefined
      ? { modelSpendCapMicroUsd: parsed.config.spendMicroUsdPer30d } : {}),
  });
}
