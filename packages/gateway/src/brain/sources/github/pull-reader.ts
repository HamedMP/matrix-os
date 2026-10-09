/**
 * Reads one pull request's details, commits, reviews and review comments, and maps them to documents plus the
 * deletions of children GitHub no longer lists. Commit shas become `commit` refs on the PR document (the merge
 * commit first), which is how git commits on the default branch map to their pull request.
 */
import type { Kysely } from "kysely";
import type { BrainSourceErrorCode, BrainSourceNotice, BrainSourceReadContext, BrainGithubSourceConfig } from "../../contracts.js";
import type { BrainDatabase } from "../../index.js";
import { listGithubChildren } from "./database.js";
import {
  githubDocumentId, isSubmittedReview, pullRequestDocument, reviewCommentDocument, reviewDocument,
  type GithubDocumentContext, type GithubUpsert,
} from "./documents.js";
import {
  GithubCommitListSchema, GithubPullSchema, GithubReviewCommentListSchema, GithubReviewListSchema, type GithubIssue,
} from "./schemas.js";
import { GITHUB_DOCUMENT_KINDS, GITHUB_LIMITS, type BrainGithubClient, type BrainGithubResource } from "./types.js";

export interface GithubItemDocuments {
  readonly upserts: readonly GithubUpsert[];
  readonly deletions: readonly string[];
  readonly notices: readonly BrainSourceNotice[];
  /** Read but not written (pending or empty comment-only reviews). */
  readonly skipped: number;
}

export type GithubItemResult =
  | { readonly ok: true; readonly documents: GithubItemDocuments }
  | { readonly ok: false; readonly code: BrainSourceErrorCode; readonly retryAfterSeconds?: number };

type ListRead<T> = { readonly ok: true; readonly items: T; readonly hasMore: boolean } | Extract<GithubItemResult, { ok: false }>;

async function readList<T>(
  client: BrainGithubClient, resource: BrainGithubResource,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, signal: AbortSignal,
): Promise<ListRead<T>> {
  const result = await client.read(resource, signal);
  if (!result.ok) return result.retryAfterSeconds === undefined
    ? { ok: false, code: result.code } : { ok: false, code: result.code, retryAfterSeconds: result.retryAfterSeconds };
  if ("notModified" in result) return { ok: false, code: "provider_output_invalid" };
  const parsed = schema.safeParse(result.data);
  return parsed.success ? { ok: true, items: parsed.data, hasMore: result.hasMore } : { ok: false, code: "provider_output_invalid" };
}

/** Provider calls one pull request costs with these settings. */
export function pullRequestCalls(config: BrainGithubSourceConfig): number {
  return config.include.reviews ? 4 : 2;
}

export async function readPullRequest(input: {
  readonly kysely: Kysely<BrainDatabase>; readonly client: BrainGithubClient; readonly doc: GithubDocumentContext;
  readonly context: BrainSourceReadContext<BrainGithubSourceConfig>; readonly issue: GithubIssue;
}): Promise<GithubItemResult> {
  const { client, context, issue } = input;
  const number = issue.number;
  const perPage = GITHUB_LIMITS.childPerPage;
  const pull = await readList(client, { kind: "pull", number }, GithubPullSchema, context.signal);
  if (!pull.ok) return pull;
  const commits = await readList(client, { kind: "pull_commits", number, perPage }, GithubCommitListSchema, context.signal);
  if (!commits.ok) return commits;
  const notices: BrainSourceNotice[] = commits.hasMore ? ["items_truncated"] : [];
  const prDocumentId = githubDocumentId(input.doc.externalRef, GITHUB_DOCUMENT_KINDS.pr, number);
  const children: GithubUpsert[] = [];
  const reviewers: string[] = [];
  let skipped = 0;
  let complete = false;
  if (context.config.include.reviews) {
    const reviews = await readList(client, { kind: "pull_reviews", number, perPage }, GithubReviewListSchema, context.signal);
    if (!reviews.ok) return reviews;
    const comments = await readList(
      client, { kind: "pull_review_comments", number, perPage }, GithubReviewCommentListSchema, context.signal,
    );
    if (!comments.ok) return comments;
    for (const review of reviews.items) {
      // Every submitted reviewer, including one whose empty comment-only review has no document of its own.
      if (review.user && isSubmittedReview(review)) reviewers.push(review.user.login);
      const built = reviewDocument(input.doc, number, prDocumentId, review, issue.updated_at);
      if (built === null) {
        skipped += 1;
        continue;
      }
      children.push(built.upsert);
      if (built.truncated) notices.push("body_truncated");
    }
    for (const comment of comments.items) {
      const built = reviewCommentDocument(input.doc, number, prDocumentId, comment);
      children.push(built.upsert);
      if (built.truncated) notices.push("body_truncated");
    }
    complete = !reviews.hasMore && !comments.hasMore;
    if (!complete) notices.push("items_truncated");
  }
  const pr = pullRequestDocument(input.doc, issue, pull.items, commits.items.map((commit) => commit.sha.toLowerCase()), reviewers);
  if (pr.truncated) notices.push("body_truncated");
  const written = new Set(children.map((child) => child.documentId));
  const deletions = complete
    ? (await listGithubChildren(input.kysely, context.scope, context.sourceId, prDocumentId)).filter((id) => !written.has(id))
    : [];
  return { ok: true, documents: { upserts: [pr.upsert, ...children], deletions, notices, skipped } };
}
