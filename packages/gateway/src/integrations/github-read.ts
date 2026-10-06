import { z } from "zod/v4";
import type { ServiceAction } from "./types.js";

const repo = z.string().max(256).regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."));
const pullNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// Require a full immutable commit ID; branch names can move between requests.
const sha = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
const pagination = {
  page: z.number().int().min(1).max(1000000).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
};
const headers = Object.freeze({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
const repoParams = { repo: { type: "string", required: true } } as const;
const prParams = { ...repoParams, pull_number: { type: "number", required: true } } as const;
const commitParams = { ...repoParams, sha: { type: "string", required: true } } as const;
const pageParams = { page: { type: "number" }, per_page: { type: "number" } } as const;

function base(params: Record<string, unknown>): string {
  return `https://api.github.com/repos/${String(params.repo).split("/").map(encodeURIComponent).join("/")}`;
}
function pageQuery(params: Record<string, unknown>): Record<string, string> {
  return { page: String(params.page ?? 1), per_page: String(params.per_page ?? 30) };
}

export const GITHUB_READ_ACTIONS: Record<string, ServiceAction> = {
  get_pr: {
    description: "Retrieve PR head SHA, requested reviewers, state and mergeability; null mergeability is unknown",
    risk: "read", params: prParams, paramsSchema: z.strictObject({ repo, pull_number: pullNumber }),
    directApi: { method: "GET", url: (p) => `${base(p)}/pulls/${p.pull_number}`, staticHeaders: headers },
  },
  list_pr_reviews: {
    description: "List a page of PR reviews; continue with page/per_page and preserve review commit_id",
    risk: "read", params: { ...prParams, ...pageParams },
    paramsSchema: z.strictObject({ repo, pull_number: pullNumber, ...pagination }),
    directApi: { method: "GET", url: (p) => `${base(p)}/pulls/${p.pull_number}/reviews`, mapParams: pageQuery, staticHeaders: headers },
  },
  list_check_runs: {
    description: "List latest check runs for a full commit SHA; empty or incomplete coverage is not CI success",
    risk: "read", params: { ...commitParams, ...pageParams }, paramsSchema: z.strictObject({ repo, sha, ...pagination }),
    directApi: {
      method: "GET", url: (p) => `${base(p)}/commits/${p.sha}/check-runs`,
      mapParams: (p) => ({ ...pageQuery(p), filter: "latest" }), staticHeaders: headers,
    },
  },
  get_combined_status: {
    description: "Retrieve combined commit status plus a page of contexts for a full commit SHA; preserve pending and total_count",
    risk: "read", params: { ...commitParams, ...pageParams }, paramsSchema: z.strictObject({ repo, sha, ...pagination }),
    directApi: { method: "GET", url: (p) => `${base(p)}/commits/${p.sha}/status`, mapParams: pageQuery, staticHeaders: headers },
  },
};
