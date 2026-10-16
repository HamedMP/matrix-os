/**
 * GitHub source: the small client seam both transports implement (REST with a token, or the integration caller),
 * limits and the tables' Kysely shapes. The adapter speaks only BrainGithubClient, so tests use a fake client.
 */
import type { BrainSourceErrorCode } from "../../contracts.js";

/** One read the adapter needs; every list is one page, newest data decided by the adapter's cursor. */
export type BrainGithubResource =
  | { readonly kind: "issues"; readonly since: string; readonly page: number; readonly perPage: number }
  | { readonly kind: "pull"; readonly number: number }
  | {
    readonly kind: "pull_commits" | "pull_reviews" | "pull_review_comments";
    readonly number: number; readonly perPage: number;
  };

/**
 * data: untrusted provider JSON, parsed by schemas.ts. hasMore: another page exists (Link rel="next", or a full
 * page when the transport has no headers). notModified: a conditional listing answered 304.
 */
export type BrainGithubFetchResult =
  | { readonly ok: true; readonly data: unknown; readonly hasMore: boolean }
  | { readonly ok: true; readonly notModified: true }
  | { readonly ok: false; readonly code: BrainSourceErrorCode; readonly retryAfterSeconds?: number };

export interface BrainGithubValidators { readonly etag: string | null; readonly lastModified: string | null }

/** Conditional request store for the listing (token mode only). */
export interface BrainGithubConditionalStore {
  lookup(requestKey: string): Promise<BrainGithubValidators | null>;
  remember(requestKey: string, validators: BrainGithubValidators): void;
}

export interface BrainGithubClient {
  readonly mode: "integration" | "token";
  read(resource: BrainGithubResource, signal: AbortSignal): Promise<BrainGithubFetchResult>;
}

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_WEB_BASE = "https://github.com";
/** Per provider call, on top of the run signal. */
export const GITHUB_CALL_TIMEOUT_MS = 10_000;
export const GITHUB_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const GITHUB_RETRY_AFTER_DEFAULT_SECONDS = 60;

export const GITHUB_LIMITS = {
  listPerPage: 50, childPerPage: 100, itemsPerPage: 25,
  callsPerPage: { token: 40, integration: 12 },
  pageSoftBudgetMs: 8_000,
  /** Issue numbers remembered at the cursor's timestamp; beyond it the cursor moves on one second. */
  doneMax: 100, tiePagesMax: 3,
  conditionalRowsPerSource: 8,
  defaultSinceDays: 365,
  /** Stored children of one pull request examined for deletions. */
  sweepMax: 500,
} as const;

export const GITHUB_DOCUMENT_KINDS = { pr: "pr", issue: "issue", review: "review", reviewComment: "review_comment" } as const;

export type BrainGithubSourcesTable = {
  owner_id: string; scope_id: string; source_id: string; repo: string; mode: "integration" | "token";
  account_label: string | null; include_pull_requests: boolean; include_reviews: boolean; include_issues: boolean;
  since: string | null; updated_at: Date | string;
};

export type BrainGithubConditionalTable = {
  owner_id: string; scope_id: string; source_id: string; request_key: string;
  etag: string | null; last_modified: string | null; pending_cursor: string; confirmed: boolean;
  updated_at: Date | string;
};

export type BrainGithubTables = {
  brain_github_sources: BrainGithubSourcesTable;
  brain_github_conditional: BrainGithubConditionalTable;
};
