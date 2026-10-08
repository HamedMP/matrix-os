/**
 * Read actions the Company Brain sources call through the Pipedream proxy (specs 558 and 560): GitHub issues and
 * pull requests, Linear issues, comments and project updates, Google Drive folder listings and Doc text, and Google
 * Calendar events. Every action is a read with a strict params schema; values that go into a URL path or a Drive
 * query are checked again where they are used, and every page size has a cap.
 */
import { z } from "zod/v4";
import { listValidation } from "./list-validation.js";
import { cappedPositiveInt, encodeOwnerRepo, linearGraphqlBody } from "./registry-params.js";
import type { ServiceAction } from "./types.js";

// Bounds shared with the existing list actions: owner/name repo, 1..1,000,000 page, 1..100 per page, and an opaque
// provider page token of 1..2048 characters with no space or control character.
const repo = listValidation.issues.shape.repo;
const page = listValidation.issues.shape.page;
const perPage = listValidation.issues.shape.per_page;
const pageToken = listValidation.drive.shape.pageToken;

// GitHub

const GITHUB_NUMBER_MAX = 999_999_999;
const githubNumber = z.number().int().min(1).max(GITHUB_NUMBER_MAX);

// Pull request numbers go into a URL path: positive integers only.
function encodeGithubNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > GITHUB_NUMBER_MAX) {
    throw new Error("number must be a positive integer");
  }
  return String(value);
}

const githubPullListParams = {
  repo: { type: "string", required: true },
  number: { type: "number", required: true },
  page: { type: "number" },
  per_page: { type: "number" },
} as const;

// GitHub API: GET /repos/{owner}/{repo}/pulls/{pull_number}/{commits|reviews|comments}, one capped page.
function githubPullListAction(description: string, suffix: "commits" | "reviews" | "comments"): ServiceAction {
  return {
    description,
    risk: "read",
    paramsSchema: z.strictObject({ repo, number: githubNumber, page, per_page: perPage }),
    params: githubPullListParams,
    directApi: {
      method: "GET",
      url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/pulls/${encodeGithubNumber(p.number)}/${suffix}`,
      mapParams: (p) => ({
        ...(p.page !== undefined ? { page: String(cappedPositiveInt(p.page, 1, 1_000_000)) } : {}),
        per_page: String(cappedPositiveInt(p.per_page, 100, 100)),
      }),
    },
  };
}

export const BRAIN_GITHUB_ACTIONS: Record<string, ServiceAction> = {
  // GitHub API: GET /repos/{owner}/{repo}/issues with every state, oldest update first. GitHub returns issues and
  // pull requests together; pull requests carry a `pull_request` field.
  list_issues_since: {
    description: "List issues and pull requests updated since a time, oldest update first (use owner/repo format)",
    risk: "read",
    paramsSchema: z.strictObject({ repo, since: z.iso.datetime(), page, per_page: perPage }),
    params: {
      repo: { type: "string", required: true },
      since: { type: "string", required: true },
      page: { type: "number" },
      per_page: { type: "number" },
    },
    directApi: {
      method: "GET",
      url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/issues`,
      mapParams: (p) => ({
        state: "all",
        sort: "updated",
        direction: "asc",
        since: String(p.since),
        page: String(cappedPositiveInt(p.page, 1, 1_000_000)),
        per_page: String(cappedPositiveInt(p.per_page, 50, 100)),
      }),
    },
  },
  // GitHub API: GET /repos/{owner}/{repo}/pulls/{pull_number} (merge commit, draft, requested reviewers).
  brain_get_pr: {
    description: "Get one pull request (use owner/repo format)",
    risk: "read",
    paramsSchema: z.strictObject({ repo, number: githubNumber }),
    params: {
      repo: { type: "string", required: true },
      number: { type: "number", required: true },
    },
    directApi: {
      method: "GET",
      url: (p) => `https://api.github.com/repos/${encodeOwnerRepo(p.repo)}/pulls/${encodeGithubNumber(p.number)}`,
    },
  },
  brain_list_pr_commits: githubPullListAction(
    "List the commits of a pull request (use owner/repo format)",
    "commits",
  ),
  brain_list_pr_reviews: githubPullListAction(
    "List the reviews of a pull request (use owner/repo format)",
    "reviews",
  ),
  brain_list_pr_review_comments: githubPullListAction(
    "List the review comments of a pull request (use owner/repo format)",
    "comments",
  ),
};
