import {
  ReviewSnapshotFileSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  type ReviewSnapshot,
  type ReviewSummary,
} from "@matrix-os/contracts";
import { resolve, sep } from "node:path";
import type { RequestPrincipal } from "../request-principal.js";
import type { ReviewLoopRecord } from "../review-loop.js";
import {
  parseFindingsFile,
  type FindingsParseFailure,
  type FindingsParseSuccess,
  type ParsedFinding,
} from "../findings-parser.js";

const REVIEW_SUMMARY_LIMIT = 50;
const RAW_REVIEW_SCAN_LIMIT = 100;
const MAX_REVIEW_SCAN_PAGES = 5;
const REVIEW_SNAPSHOT_FILE_LIMIT = 100;
const REVIEW_SNAPSHOT_FINDINGS_PER_FILE_LIMIT = 100;

type ReviewSnapshotErrorCode = "review_not_found" | "review_state_unavailable";

export class CodingAgentReviewSnapshotError extends Error {
  constructor(public readonly code: ReviewSnapshotErrorCode) {
    super(code === "review_not_found" ? "Review was not found" : "Review state unavailable");
  }
}

export interface CodingAgentReviewSummaryStore {
  listReviews(
    principal: RequestPrincipal,
    options?: { cursor?: string },
  ): Promise<{ items: ReviewSummary[]; hasMore: boolean; limit: number; nextCursor?: string }>;
  getReviewSnapshot?(
    principal: RequestPrincipal,
    reviewId: string,
  ): Promise<ReviewSnapshot>;
}

export interface ReviewLoopStore {
  getReview?(reviewId: string): Promise<
    { ok: true; review: ReviewLoopRecord } |
    { ok: false; status: number; error: { code: string; message: string } }
  >;
  listReviews(input?: unknown): Promise<
    { ok: true; reviews: ReviewLoopRecord[]; nextCursor: string | null } |
    { ok: false; status: number; error: { code: string; message: string } }
  >;
}

function ownerIdsFor(options: { ownerId?: string; principalOwnerIds?: readonly string[] }): string[] {
  const ids: string[] = [];
  for (const id of [options.ownerId, ...(options.principalOwnerIds ?? [])]) {
    if (!id || ids.includes(id) || ids.length >= 8) continue;
    ids.push(id);
  }
  return ids;
}

function canReadReviewSummaries(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function findingsFor(review: ReviewLoopRecord): ReviewSummary["findings"] {
  const latest = review.rounds
    .slice()
    .reverse()
    .find((round) => typeof round.findingsCount === "number" || round.severityCounts);
  if (!latest) return undefined;
  const high = latest.severityCounts?.high ?? 0;
  const medium = latest.severityCounts?.medium ?? 0;
  const low = latest.severityCounts?.low ?? 0;
  return {
    total: latest.findingsCount ?? high + medium + low,
    high,
    medium,
    low,
  };
}

function safeStatusFor(review: ReviewLoopRecord): string | undefined {
  if (review.status === "failed_parse") return "Review output could not be read. Try another review run.";
  if (review.status === "failed") return "Review stopped before completion. Try again.";
  if (review.status === "stalled") return "Review needs attention before continuing.";
  return undefined;
}

function toReviewSummary(review: ReviewLoopRecord): ReviewSummary | null {
  const parsed = ReviewSummarySchema.safeParse({
    id: review.id,
    projectId: review.projectSlug,
    worktreeId: review.worktreeId,
    status: review.status,
    pullRequestNumber: review.pr,
    round: review.round,
    maxRounds: review.maxRounds,
    reviewer: review.reviewer,
    implementer: review.implementer,
    findings: findingsFor(review),
    safeStatus: safeStatusFor(review),
    updatedAt: review.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

type FindingsReader = (path: string) => Promise<FindingsParseSuccess | FindingsParseFailure>;

function latestSuccessfulFindingsRound(review: ReviewLoopRecord) {
  return review.rounds
    .slice()
    .reverse()
    .find((round) => round.parserStatus === "success" && typeof round.findingsPath === "string" && round.findingsPath.length > 0)
}

function reviewOwnerMatchesPrincipal(review: ReviewLoopRecord, principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (!canReadReviewSummaries(principal, ownerIds)) return false;
  if (!review.ownerId) return true;
  return ownerIds.includes(review.ownerId);
}

function safeFindingsPath(input: { homePath?: string; review: ReviewLoopRecord; round: number; findingsPath?: string }): string | null {
  if (!input.homePath || !input.findingsPath) return null;
  if (input.findingsPath !== `.matrix/review-round-${input.round}.md`) return null;
  const safeProject = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(input.review.projectSlug);
  const safeWorktree = /^wt_[A-Za-z0-9_-]{1,128}$/.test(input.review.worktreeId);
  if (!safeProject || !safeWorktree) return null;
  const worktreeRoot = resolve(input.homePath, "projects", input.review.projectSlug, "worktrees", input.review.worktreeId);
  const resolved = resolve(worktreeRoot, input.findingsPath);
  return resolved.startsWith(`${worktreeRoot}${sep}`) ? resolved : null;
}

function snapshotFilesFromFindings(review: ReviewLoopRecord, findings: ParsedFinding[]) {
  const files = new Map<string, ParsedFinding[]>();
  let hasMore = false;
  for (const finding of findings) {
    if (files.size >= REVIEW_SNAPSHOT_FILE_LIMIT && !files.has(finding.file)) {
      hasMore = true;
      continue;
    }
    const current = files.get(finding.file) ?? [];
    if (current.length >= REVIEW_SNAPSHOT_FINDINGS_PER_FILE_LIMIT) continue;
    current.push(finding);
    files.set(finding.file, current);
  }

  const items = [...files.entries()]
    .map(([path, fileFindings], fileIndex) => ReviewSnapshotFileSchema.safeParse({
      path,
      status: "modified",
      additions: 0,
      deletions: 0,
      partial: true,
      hunks: fileFindings.map((finding, findingIndex) => ({
        id: `hunk_${review.id}_${fileIndex}_${findingIndex}`,
        oldStart: finding.line,
        oldLines: 1,
        newStart: finding.line,
        newLines: 1,
        heading: `Finding ${finding.id}`,
        partial: true,
      })),
      findings: fileFindings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        line: finding.line,
        summary: finding.summary,
      })),
    }))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  return { items, hasMore };
}

async function toPartialReviewSnapshot(
  review: ReviewLoopRecord,
  options: { findingsReader: FindingsReader; homePath?: string },
): Promise<ReviewSnapshot | null> {
  const summary = toReviewSummary(review);
  if (!summary) return null;
  const findingsRound = latestSuccessfulFindingsRound(review);
  const findingsPath = findingsRound
    ? safeFindingsPath({
      homePath: options.homePath,
      review,
      round: findingsRound.round,
      findingsPath: findingsRound.findingsPath,
    })
    : null;
  const parsedFindings = findingsPath ? await options.findingsReader(findingsPath) : null;
  const files = parsedFindings?.ok ? snapshotFilesFromFindings(review, parsedFindings.findings) : { items: [], hasMore: false };
  const parsed = ReviewSnapshotSchema.safeParse({
    review: summary,
    files: {
      items: files.items.slice(0, REVIEW_SNAPSHOT_FILE_LIMIT),
      hasMore: files.hasMore,
      limit: REVIEW_SNAPSHOT_FILE_LIMIT,
    },
    partial: true,
    safeNotice: files.items.length > 0
      ? "Diff content is not available yet. Showing bounded review findings."
      : "Diff content is not available yet. Showing bounded review state.",
    updatedAt: review.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

export function createCodingAgentReviewSummaryStore(
  store: ReviewLoopStore,
  options: { ownerId?: string; principalOwnerIds?: readonly string[]; findingsReader?: FindingsReader; homePath?: string } = {},
): CodingAgentReviewSummaryStore {
  const ownerIds = ownerIdsFor(options);
  const findingsReader = options.findingsReader ?? parseFindingsFile;
  return {
    async listReviews(principal: RequestPrincipal, listOptions: { cursor?: string } = {}) {
      if (!canReadReviewSummaries(principal, ownerIds)) {
        return { items: [], hasMore: false, limit: REVIEW_SUMMARY_LIMIT };
      }
      const validSummaries: ReviewSummary[] = [];
      let cursor = listOptions.cursor;
      let rawContinuationCursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let page = 0; page < MAX_REVIEW_SCAN_PAGES && validSummaries.length <= REVIEW_SUMMARY_LIMIT; page += 1) {
        if (cursor && seenCursors.has(cursor)) break;
        if (cursor) seenCursors.add(cursor);
        const result = await store.listReviews({ limit: RAW_REVIEW_SCAN_LIMIT, cursor });
        if (!result.ok) {
          throw new Error("Review state unavailable");
        }
        validSummaries.push(
          ...result.reviews
            .map(toReviewSummary)
            .filter((summary): summary is ReviewSummary => summary !== null),
        );
        if (!result.nextCursor) break;
        if (seenCursors.has(result.nextCursor)) {
          rawContinuationCursor = undefined;
          break;
        }
        rawContinuationCursor = result.nextCursor;
        cursor = result.nextCursor;
      }
      const items = validSummaries.slice(0, REVIEW_SUMMARY_LIMIT);
      const hasMore = validSummaries.length > REVIEW_SUMMARY_LIMIT || rawContinuationCursor !== undefined;
      return {
        items,
        hasMore,
        nextCursor: hasMore ? items[items.length - 1]?.id ?? rawContinuationCursor : undefined,
        limit: REVIEW_SUMMARY_LIMIT,
      };
    },

    async getReviewSnapshot(principal: RequestPrincipal, reviewId: string) {
      if (!canReadReviewSummaries(principal, ownerIds)) {
        throw new CodingAgentReviewSnapshotError("review_not_found");
      }
      if (!("getReview" in store) || typeof store.getReview !== "function") {
        throw new CodingAgentReviewSnapshotError("review_state_unavailable");
      }
      const result = await store.getReview(reviewId);
      if (!result.ok) {
        throw new CodingAgentReviewSnapshotError(result.status === 404 || result.status === 403 ? "review_not_found" : "review_state_unavailable");
      }
      if (!reviewOwnerMatchesPrincipal(result.review, principal, ownerIds)) {
        throw new CodingAgentReviewSnapshotError("review_not_found");
      }
      const snapshot = await toPartialReviewSnapshot(result.review, { findingsReader, homePath: options.homePath });
      if (!snapshot) {
        throw new CodingAgentReviewSnapshotError("review_state_unavailable");
      }
      return snapshot;
    },
  };
}
