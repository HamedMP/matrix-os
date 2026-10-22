import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";

const repo = z.string().max(256).regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."));
const pullNumber = z.number().int().min(1).max(2147483647);
const pagination = { page: z.number().int().min(1).max(1000000).optional(), perPage: z.number().int().min(1).max(100).optional() };
const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
const root = (p: Record<string, unknown>) => `https://api.github.com/repos/${repo.parse(p.repo).split("/").map(encodeURIComponent).join("/")}`;
const pageParams = (p: Record<string, unknown>): Record<string, string> => ({ page: String(p.page ?? 1), per_page: String(p.perPage ?? 30) });
function pullAction(description: string, suffix = "", paged = false): ServiceAction {
  return {
    description, risk: "read",
    params: { repo: { type: "string", required: true }, pullNumber: { type: "number", required: true }, ...(paged ? { page: { type: "number" as const }, perPage: { type: "number" as const } } : {}) },
    paramsSchema: z.strictObject({ repo, pullNumber, ...(paged ? pagination : {}) }),
    directApi: { method: "GET", url: (p) => `${root(p)}/pulls/${pullNumber.parse(p.pullNumber)}${suffix}`, staticHeaders: headers, ...(paged ? { mapParams: pageParams } : {}) },
  };
}

/** One page per call. No write/merge permissions are implied by repository access. */
export const GITHUB_DEPTH_ACTIONS: Record<string, ServiceAction> = {
  get_pr: pullAction("Read a pull request's body, head/base revisions and merge state"),
  list_pr_reviews: pullAction("Read a page of submitted pull request reviews", "/reviews", true),
  list_pr_review_comments: pullAction("Read a page of inline pull request review comments", "/comments", true),
  list_pr_files: pullAction("Read a page of changed pull request files and available patches", "/files", true),
  list_pr_commits: pullAction("Read a page of commits belonging to a pull request", "/commits", true),
  list_check_runs: {
    description: "Read a page of check runs for a commit SHA or a single-segment branch/tag", risk: "read",
    params: { repo: { type: "string", required: true }, ref: { type: "string", required: true }, page: { type: "number" }, perPage: { type: "number" } },
    paramsSchema: z.strictObject({ repo, ref: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/).refine((value) => value !== "." && value !== ".."), ...pagination }),
    directApi: { method: "GET", url: (p) => `${root(p)}/commits/${encodeURIComponent(String(p.ref))}/check-runs`, staticHeaders: headers, mapParams: pageParams },
  },
};
