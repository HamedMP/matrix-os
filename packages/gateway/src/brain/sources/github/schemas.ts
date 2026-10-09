/**
 * Bounded schemas for the GitHub JSON the adapter reads. Provider objects carry many more fields, so unknown keys
 * are dropped (z.object), but every field that is used is typed and bounded; anything else is provider_output_invalid.
 */
import { z } from "zod/v4";

const TEXT_MAX = 262_144;
const time = z.iso.datetime({ offset: true });
const number = z.number().int().min(1).max(999_999_999);
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const login = z.string().min(1).max(100);
const user = z.object({ login }).nullable();
const label = z.union([z.string().max(256), z.object({ name: z.string().max(256) })]);

export const GithubIssueSchema = z.object({
  number,
  title: z.string().max(1_024),
  body: z.string().max(TEXT_MAX).nullable().optional(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().max(32).nullable().optional(),
  user,
  labels: z.array(label).max(100).optional(),
  assignees: z.array(z.object({ login })).max(100).nullable().optional(),
  updated_at: time,
  closed_at: time.nullable().optional(),
  draft: z.boolean().optional(),
  pull_request: z.object({ merged_at: time.nullable().optional() }).optional(),
});
export type GithubIssue = z.infer<typeof GithubIssueSchema>;
export const GithubIssueListSchema = z.array(GithubIssueSchema).max(100);

export const GithubPullSchema = z.object({
  number,
  draft: z.boolean().optional(),
  merged_at: time.nullable().optional(),
  merge_commit_sha: z.string().max(64).nullable().optional(),
  requested_reviewers: z.array(z.object({ login })).max(100).nullable().optional(),
});
export type GithubPull = z.infer<typeof GithubPullSchema>;

export const GithubCommitListSchema = z.array(z.object({ sha: z.string().max(64) })).max(100);

export const GithubReviewListSchema = z.array(z.object({
  id,
  user,
  body: z.string().max(TEXT_MAX).nullable().optional(),
  state: z.string().max(32),
  submitted_at: time.nullable().optional(),
})).max(100);
export type GithubReview = z.infer<typeof GithubReviewListSchema>[number];

export const GithubReviewCommentListSchema = z.array(z.object({
  id,
  user,
  body: z.string().max(TEXT_MAX),
  path: z.string().max(4_096).nullable().optional(),
  line: z.number().int().min(0).max(10_000_000).nullable().optional(),
  in_reply_to_id: id.nullable().optional(),
  updated_at: time,
})).max(100);
export type GithubReviewComment = z.infer<typeof GithubReviewCommentListSchema>[number];
