import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import type { WorkspaceError } from "./project-manager.js";
import { atomicWriteJson, readJsonFile } from "./state-ops.js";
import type { ReviewLoopRecord } from "./review-loop.js";

type Failure = {
  ok: false;
  status: number;
  error: WorkspaceError;
};

const ReviewIdSchema = z.string().regex(/^rev_[A-Za-z0-9_-]{1,128}$/);
const ListReviewsSchema = z.object({
  projectSlug: z.string().min(1).max(63).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function reviewPath(homePath: string, reviewId: string): string {
  return join(homePath, "system", "reviews", `${reviewId}.json`);
}

async function readReview(homePath: string, reviewId: string): Promise<ReviewLoopRecord | null> {
  try {
    return await readJsonFile<ReviewLoopRecord>(reviewPath(homePath, reviewId));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function createReviewStore(options: { homePath: string }) {
  const homePath = resolve(options.homePath);
  const reviewsDir = join(homePath, "system", "reviews");

  return {
    async saveReview(review: ReviewLoopRecord): Promise<{ ok: true } | Failure> {
      if (!ReviewIdSchema.safeParse(review.id).success) {
        return failure(400, "invalid_review_id", "Review identifier is invalid");
      }
      await atomicWriteJson(reviewPath(homePath, review.id), review);
      return { ok: true };
    },

    async getReview(reviewId: string): Promise<{ ok: true; review: ReviewLoopRecord } | Failure> {
      if (!ReviewIdSchema.safeParse(reviewId).success) {
        return failure(400, "invalid_review_id", "Review identifier is invalid");
      }
      const review = await readReview(homePath, reviewId);
      if (!review) return failure(404, "not_found", "Review was not found");
      return { ok: true, review };
    },

    async listReviews(input: unknown = {}): Promise<
      { ok: true; reviews: ReviewLoopRecord[]; nextCursor: null } | Failure
    > {
      const parsed = ListReviewsSchema.safeParse(input);
      if (!parsed.success) {
        return failure(400, "invalid_review_query", "Review query is invalid");
      }
      let entries;
      try {
        entries = await readdir(reviewsDir, { withFileTypes: true });
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: true, reviews: [], nextCursor: null };
        }
        throw err;
      }

      const reviews: ReviewLoopRecord[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const reviewId = entry.name.slice(0, -".json".length);
        if (!ReviewIdSchema.safeParse(reviewId).success) continue;
        const review = await readReview(homePath, reviewId);
        if (review) reviews.push(review);
      }
      const query = parsed.data;
      return {
        ok: true,
        reviews: reviews
          .filter((review) => !query.projectSlug || review.projectSlug === query.projectSlug)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, query.limit ?? 100),
        nextCursor: null,
      };
    },
  };
}
