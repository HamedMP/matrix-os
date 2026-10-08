/**
 * Impact brief service: for a branch or base..head range of a project checkout, the files changed since the merge
 * base, the files importing them (approximate), the earlier pull requests, invariants and decisions the brain holds
 * for those files, changed code without a nearby test change, and the spec folders touched. Read-only: no fetch, no
 * checkout, no store writes. Holds no timers, caches or connections; only a count of the briefs running now, at most
 * IMPACT_MAX_CONCURRENT_BRIEFS.
 */
import { z } from "zod/v4";
import { BrainApiError } from "../api/types.js";
import { withBrainRead } from "../bounded.js";
import {
  BRAIN_IMPACT_LIMITS, BRAIN_IMPACT_REV_MAX_CHARS, BrainFeatureError, type BrainImpactNotice, type BrainImpactQuery,
  type BrainImpactService, type BrainImpactServiceDeps, type BrainImpactView,
} from "../contracts.js";
import { isSafeBranchName } from "../git/parse.js";
import { defaultGitRunner } from "../git/reader.js";
import { GitSourceError, type GitSyncErrorCode } from "../git/types.js";
import type { BrainScopeKey } from "../types.js";
import { currentClaims, findGitSource, priorPullRequests, specCites } from "./brain.js";
import { formatBrainImpactComment } from "./comment.js";
import { openImpactGit, type ImpactGit } from "./git.js";
import { isTestPath, specsTouched, untestedFiles } from "./paths.js";
import { scanDependents } from "./scan.js";

/** Briefs one service runs at once; each holds several git processes and an import graph, so more are refused. */
export const IMPACT_MAX_CONCURRENT_BRIEFS = 4;
/** Depth when the query has none: depth-2 files fill the dependents slots that depth-1 files leave free. */
export const IMPACT_DEPTH_DEFAULT: 1 | 2 = BRAIN_IMPACT_LIMITS.depthDefault;
const HEX_REV = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/;
const NOTICE_ORDER: readonly BrainImpactNotice[] = [
  "changed_files_capped", "dependents_capped", "scan_capped", "read_budget_exhausted", "run_budget_exhausted",
  "no_git_source", "brain_behind_head",
];
/** Repository states that make the checkout unusable for this brief. */
const CHECKOUT_CODES: ReadonlySet<GitSyncErrorCode> = new Set([
  "not_a_repository", "shallow_repository", "invalid_options",
]);
const SHORT_REF = /^refs\/(?:heads|remotes\/origin)\//;

/** The impact view; dependentTotals (files per depth before the dependents cap) is part of the contract. */
export type BrainImpactBrief = BrainImpactView;

/** A short branch name or a full or 7..64 hex abbreviated sha. */
export function isImpactRev(value: string): boolean {
  return value.length <= BRAIN_IMPACT_REV_MAX_CHARS && (HEX_REV.test(value) || isSafeBranchName(value));
}

const RevSchema = z.string().min(1).max(BRAIN_IMPACT_REV_MAX_CHARS).refine(isImpactRev);
export const BrainImpactQuerySchema = z.object({
  head: RevSchema, base: RevSchema.optional(), depth: z.union([z.literal(1), z.literal(2)]).optional(),
}).strict();

function mapGitError(err: unknown): unknown {
  if (!(err instanceof GitSourceError)) return err;
  if (err.code === "branch_unavailable") return new BrainFeatureError("git_ref_not_found", { cause: err });
  if (CHECKOUT_CODES.has(err.code)) return new BrainApiError("checkout_unavailable", { cause: err });
  console.error("[brain-impact] git read failed:", err.code);
  return new BrainApiError("brain_unavailable", { cause: err });
}

async function resolve(git: ImpactGit, rev: string): Promise<{ ref: string; sha: string }> {
  const resolved = await git.resolveRev(rev);
  if (resolved === null) throw new BrainFeatureError("git_ref_not_found");
  return { ref: rev, sha: resolved.sha };
}

/** The brain's git sync has not applied the merge base yet, so earlier work may be missing. */
async function brainBehind(git: ImpactGit, position: string | null, mergeBase: string): Promise<boolean> {
  if (position === null || !git.repo.shaPattern.test(position)) return true;
  return position !== mergeBase && !(await git.repo.isAncestor(mergeBase, position));
}

export function createBrainImpactService(deps: BrainImpactServiceDeps): BrainImpactService {
  const runner = deps.runner ?? defaultGitRunner;
  const now = deps.now ?? Date.now;
  const limits = BRAIN_IMPACT_LIMITS;
  let running = 0;

  async function build(scope: BrainScopeKey, repoPath: string, query: BrainImpactQuery): Promise<BrainImpactBrief> {
    const deadline = now() + limits.runBudgetMs;
    const git = await openImpactGit({ repoPath, homePath: deps.resolver.homePath, runner });
    const head = await resolve(git, query.head);
    let base: { ref: string; sha: string };
    if (query.base === undefined) {
      const tip = await git.repo.resolveTip(null);
      base = { ref: tip.ref.replace(SHORT_REF, ""), sha: tip.sha };
    } else {
      base = await resolve(git, query.base);
    }
    const mergeBase = await git.mergeBase(base.sha, head.sha);
    if (mergeBase === null) throw new BrainApiError("invalid_request");
    const notices = new Set<BrainImpactNotice>();
    const diff = await git.diff(mergeBase, head.sha);
    if (diff.truncated || diff.files.length > limits.changedFilesMax) notices.add("changed_files_capped");
    const changed = diff.files.slice(0, limits.changedFilesMax);
    const scan = await scanDependents({
      git, head: head.sha, changed, depth: query.depth ?? IMPACT_DEPTH_DEFAULT, deadline, now,
    });
    for (const notice of scan.notices) notices.add(notice);

    const source = await findGitSource(deps.repository, scope);
    if (source === null) notices.add("no_git_source");
    else if (await brainBehind(git, source.position, mergeBase)) notices.add("brain_behind_head");
    const lookup = [...new Set(changed.flatMap((file) => [file.path, file.previousPath ?? file.path]))];
    const priorPaths = [...lookup.filter((path) => !isTestPath(path)), ...lookup.filter(isTestPath)]
      .slice(0, limits.filesWithPriorMax * 2);
    const touched = specsTouched(changed, limits.specsMax);
    const asOf = await git.commitTime(mergeBase);
    const [prior, invariants, decisions, cites] = await withBrainRead(deps.repository.kysely, async (db) => [
      await priorPullRequests(db, scope, priorPaths, limits.priorPerFile, limits.filesWithPriorMax, asOf),
      await currentClaims(db, scope, lookup, "invariant", limits.claimsPerKindMax, asOf),
      await currentClaims(db, scope, lookup, "decision", limits.claimsPerKindMax, asOf),
      await specCites(db, scope, touched.map((spec) => spec.spec)),
    ] as const);
    return {
      base, head, mergeBase,
      changedFiles: changed.map((file) => ({ ...file, isTest: isTestPath(file.path) })),
      changedTotal: diff.total, dependents: scan.dependents, dependentTotals: scan.totals, approximate: true, prior,
      invariants, decisions,
      untested: untestedFiles(changed, scan.testImports, limits.untestedMax),
      specs: touched.map((spec) => ({ ...spec, cite: cites.get(spec.spec) ?? null })),
      notices: NOTICE_ORDER.filter((notice) => notices.has(notice)),
    };
  }

  async function impact(ownerId: string, projectRef: string, query: BrainImpactQuery): Promise<BrainImpactBrief> {
    const parsed = BrainImpactQuerySchema.safeParse(query);
    if (!parsed.success) throw new BrainApiError("invalid_request", { cause: parsed.error });
    if (running >= IMPACT_MAX_CONCURRENT_BRIEFS) {
      console.warn("[brain-impact] brief refused: too many running", { running });
      throw new BrainApiError("brain_unavailable");
    }
    running += 1;
    try {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const repoPath = await deps.resolver.checkoutPath(ownerId, project);
      if (repoPath === null) throw new BrainApiError("checkout_unavailable");
      try {
        return await build(project.scope, repoPath, parsed.data);
      } catch (err: unknown) {
        throw mapGitError(err);
      }
    } finally {
      running -= 1;
    }
  }

  return {
    impact,
    async comment(ownerId, projectRef, query) {
      return formatBrainImpactComment(await impact(ownerId, projectRef, query));
    },
  };
}
