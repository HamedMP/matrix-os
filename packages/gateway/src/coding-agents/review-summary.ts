import {
  ReviewSummarySchema,
  type ReviewSummary,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ReviewLoopRecord } from "../review-loop.js";

const REVIEW_SUMMARY_LIMIT = 50;
const RAW_REVIEW_SCAN_LIMIT = 100;
const MAX_REVIEW_SCAN_PAGES = 5;

export interface CodingAgentReviewSummaryStore {
  listReviews(
    principal: RequestPrincipal,
    options?: { cursor?: string },
  ): Promise<{ items: ReviewSummary[]; hasMore: boolean; limit: number; nextCursor?: string }>;
}

export interface ReviewLoopStore {
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

export function createCodingAgentReviewSummaryStore(
  store: ReviewLoopStore,
  options: { ownerId?: string; principalOwnerIds?: readonly string[] } = {},
): CodingAgentReviewSummaryStore {
  const ownerIds = ownerIdsFor(options);
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
  };
}
