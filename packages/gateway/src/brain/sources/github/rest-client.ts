/**
 * GitHub REST client for token mode (self-host): an explicit token, api.github.com only, one bounded call per
 * resource with a per-call timeout on top of the run signal, a byte cap, no redirects, rate-limit handling and
 * conditional listing requests (ETag / If-Modified-Since). The token is only ever placed in the Authorization header.
 */
import { createHash } from "node:crypto";
import { BRAIN_INTEGRATION_RETRY_AFTER_MAX_SECONDS, type BrainSourceErrorCode } from "../../contracts.js";
import { discardBody, readBoundedJson, readJsonField } from "../integration/bounded-body.js";
import {
  GITHUB_API_BASE, GITHUB_CALL_TIMEOUT_MS, GITHUB_RESPONSE_MAX_BYTES, GITHUB_RETRY_AFTER_DEFAULT_SECONDS,
  type BrainGithubClient, type BrainGithubConditionalStore, type BrainGithubFetchResult, type BrainGithubResource,
} from "./types.js";

const ETAG_PATTERN = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const LAST_MODIFIED_PATTERN = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export interface BrainGithubRestClientOptions {
  readonly token: string;
  readonly repo: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly conditional?: BrainGithubConditionalStore;
  /** Milliseconds clock for rate-limit resets; default Date.now. */
  readonly now?: () => number;
}

/** Path and query of one resource; also the conditional store key's input. */
export function githubResourcePath(repo: string, resource: BrainGithubResource): string {
  const base = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
  switch (resource.kind) {
    case "issues": {
      const query = new URLSearchParams({
        state: "all", sort: "updated", direction: "asc", since: resource.since,
        per_page: String(resource.perPage), page: String(resource.page),
      });
      return `${base}/issues?${query.toString()}`;
    }
    case "pull": return `${base}/pulls/${resource.number}`;
    case "pull_commits": return `${base}/pulls/${resource.number}/commits?per_page=${resource.perPage}`;
    case "pull_reviews": return `${base}/pulls/${resource.number}/reviews?per_page=${resource.perPage}`;
    case "pull_review_comments": return `${base}/pulls/${resource.number}/comments?per_page=${resource.perPage}`;
  }
}

export function githubRequestKey(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

function failure(code: BrainSourceErrorCode, retryAfterSeconds?: number): BrainGithubFetchResult {
  return retryAfterSeconds === undefined ? { ok: false, code } : { ok: false, code, retryAfterSeconds };
}

function boundedRetry(seconds: number): number {
  return Math.min(Math.max(Math.ceil(seconds), 1), BRAIN_INTEGRATION_RETRY_AFTER_MAX_SECONDS);
}

export function createGithubRestClient(options: BrainGithubRestClientOptions): BrainGithubClient {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? GITHUB_CALL_TIMEOUT_MS;
  /** Set when GitHub reported no requests left; later calls of this run stop without calling until the reset. */
  let exhaustedUntil = 0;

  function rateLimit(response: Response): number | null {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return boundedRetry(retryAfter);
    if (response.headers.get("x-ratelimit-remaining") !== "0") return null;
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    return boundedRetry(Number.isFinite(reset) && reset > 0 ? reset - now() / 1000 : GITHUB_RETRY_AFTER_DEFAULT_SECONDS);
  }

  async function statusFailure(response: Response, signal: AbortSignal): Promise<BrainGithubFetchResult> {
    const status = response.status;
    const limited = status === 403 || status === 429 ? rateLimit(response) : null;
    let secondary = false;
    if (status === 403 && limited === null) {
      // A secondary rate limit can be a 403 with no rate-limit headers, only a message saying so.
      const message = await readJsonField(response, "message", signal);
      secondary = typeof message === "string" && /rate limit/i.test(message.slice(0, 4_096));
    } else {
      discardBody(response);
    }
    if (limited !== null || secondary || status === 429) {
      const seconds = limited ?? GITHUB_RETRY_AFTER_DEFAULT_SECONDS;
      exhaustedUntil = now() + seconds * 1000;
      return failure("rate_limited", seconds);
    }
    if (status === 401 || status === 403) return failure("auth_failed");
    if (status === 404 || status === 410 || (status >= 300 && status < 400)) return failure("remote_not_found");
    if (status === 400 || status === 422) return failure("config_invalid");
    return failure("provider_unavailable");
  }

  async function conditionalHeaders(headers: Headers, key: string | null): Promise<void> {
    if (key === null || options.conditional === undefined) return;
    const validators = await options.conditional.lookup(key);
    if (validators?.etag) headers.set("if-none-match", validators.etag);
    if (validators?.lastModified) headers.set("if-modified-since", validators.lastModified);
  }

  function remember(response: Response, key: string | null): void {
    if (key === null || options.conditional === undefined) return;
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    const validEtag = etag !== null && ETAG_PATTERN.test(etag) ? etag : null;
    const validModified = lastModified !== null && LAST_MODIFIED_PATTERN.test(lastModified) ? lastModified : null;
    if (validEtag !== null || validModified !== null) options.conditional.remember(key, { etag: validEtag, lastModified: validModified });
  }

  return {
    mode: "token",
    async read(resource, runSignal) {
      if (exhaustedUntil > now()) return failure("rate_limited", boundedRetry((exhaustedUntil - now()) / 1000));
      const path = githubResourcePath(options.repo, resource);
      const key = resource.kind === "issues" ? githubRequestKey(path) : null;
      const headers = new Headers({
        Authorization: `Bearer ${options.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "matrix-os-company-brain",
      });
      await conditionalHeaders(headers, key);
      const callSignal = AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
      try {
        const response = await fetcher(`${GITHUB_API_BASE}${path}`, { headers, redirect: "manual", signal: callSignal });
        if (response.status === 304) {
          discardBody(response);
          return { ok: true, notModified: true };
        }
        if (response.status !== 200) return await statusFailure(response, callSignal);
        const exhausted = rateLimit(response);
        if (exhausted !== null) exhaustedUntil = now() + exhausted * 1000;
        const body = await readBoundedJson(response, GITHUB_RESPONSE_MAX_BYTES, callSignal);
        if (!body.ok) return failure("provider_output_invalid");
        remember(response, key);
        return { ok: true, data: body.value, hasMore: /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "") };
      } catch (error: unknown) {
        const name = error instanceof Error ? error.name : "UnknownError";
        console.warn(`[brain-github] ${resource.kind} request failed:`, name);
        if (name === "TimeoutError" || name === "AbortError" || callSignal.aborted) return failure("provider_timeout");
        if (error instanceof TypeError) return failure("provider_unavailable");
        throw error;
      }
    },
  };
}
