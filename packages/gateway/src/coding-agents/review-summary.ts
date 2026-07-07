import {
  ReviewSnapshotFileSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  type ReviewSnapshot,
  type ReviewSummary,
} from "@matrix-os/contracts";
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

function latestSuccessfulFindingsPath(review: ReviewLoopRecord): string | undefined {
  return review.rounds
    .slice()
    .reverse()
    .find((round) => round.parserStatus === "success" && typeof round.findingsPath === "string" && round.findingsPath.length > 0)
    ?.findingsPath;
}

function snapshotFilesFromFindings(review: ReviewLoopRecord, findings: ParsedFinding[]) {
  const files = new Map<string, ParsedFinding[]>();
  for (const finding of findings) {
    if (files.size >= REVIEW_SNAPSHOT_FILE_LIMIT && !files.has(finding.file)) break;
    const current = files.get(finding.file) ?? [];
    if (current.length >= REVIEW_SNAPSHOT_FINDINGS_PER_FILE_LIMIT) continue;
    current.push(finding);
    files.set(finding.file, current);
  }

  return [...files.entries()]
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
}

async function toPartialReviewSnapshot(review: ReviewLoopRecord, findingsReader: FindingsReader): Promise<ReviewSnapshot | null> {
  const summary = toReviewSummary(review);
  if (!summary) return null;
  const findingsPath = latestSuccessfulFindingsPath(review);
  const parsedFindings = findingsPath ? await findingsReader(findingsPath) : null;
  const files = parsedFindings?.ok ? snapshotFilesFromFindings(review, parsedFindings.findings) : [];
  const parsed = ReviewSnapshotSchema.safeParse({
    review: summary,
    files: {
      items: files.slice(0, REVIEW_SNAPSHOT_FILE_LIMIT),
      hasMore: files.length > REVIEW_SNAPSHOT_FILE_LIMIT,
      limit: REVIEW_SNAPSHOT_FILE_LIMIT,
    },
    partial: true,
    safeNotice: files.length > 0
      ? "Diff content is not available yet. Showing bounded review findings."
      : "Diff content is not available yet. Showing bounded review state.",
    updatedAt: review.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

export function createCodingAgentReviewSummaryStore(
  store: ReviewLoopStore,
  options: { ownerId?: string; principalOwnerIds?: readonly string[]; findingsReader?: FindingsReader } = {},
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
        throw new Error("Review state unavailable");
      }
      if (!("getReview" in store) || typeof store.getReview !== "function") {
        throw new Error("Review state unavailable");
      }
      const result = await store.getReview(reviewId);
      if (!result.ok) {
        throw new Error("Review state unavailable");
      }
      const snapshot = await toPartialReviewSnapshot(result.review, findingsReader);
      if (!snapshot) {
        throw new Error("Review state unavailable");
      }
      return snapshot;
    },
  };
}
