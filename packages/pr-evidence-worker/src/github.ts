import { BoundedTtlMap } from "./bounded.js";
import { sha256Hex } from "./encoding.js";

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_TIMEOUT_MS = 10_000;
export const AUTH_CACHE_TTL_MS = 5 * 60 * 1000;
const AUTH_CACHE_MAX_ENTRIES = 500;
const PR_CACHE_MAX_ENTRIES = 1_000;
const USER_AGENT = "matrix-pr-evidence";

const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export type GitHubDecision =
  | { ok: true; login: string }
  | { ok: false; status: 401 | 403 | 404 | 503; error: string };

export interface GitHubAuthorizerOptions {
  repo: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Authorizes an uploader by asking GitHub whether the bearer token belongs to
 * a user with write access to the repository. The token itself is never
 * stored or logged; only its SHA-256 digest keys the short-lived allow cache.
 */
export class GitHubAuthorizer {
  private readonly allowCache: BoundedTtlMap<string>;
  private readonly prCache: BoundedTtlMap<true>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubAuthorizerOptions) {
    const now = options.now ?? Date.now;
    this.allowCache = new BoundedTtlMap(AUTH_CACHE_MAX_ENTRIES, AUTH_CACHE_TTL_MS, now);
    this.prCache = new BoundedTtlMap(PR_CACHE_MAX_ENTRIES, AUTH_CACHE_TTL_MS, now);
    // Every call passes AbortSignal.timeout(GITHUB_TIMEOUT_MS); see call().
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async authorize(token: string, pr: number): Promise<GitHubDecision> {
    if (!TOKEN_PATTERN.test(token)) return { ok: false, status: 401, error: "unauthorized" };
    const digest = await sha256Hex(token);
    let login = this.allowCache.get(digest);
    if (!login) {
      const decision = await this.resolveWriter(token);
      if (!decision.ok) return decision;
      login = decision.login;
      this.allowCache.set(digest, login);
    }
    const prDecision = await this.checkPullRequest(token, pr);
    if (!prDecision.ok) return prDecision;
    return { ok: true, login };
  }

  private async resolveWriter(token: string): Promise<GitHubDecision> {
    const user = await this.call(token, "/user");
    if (user.kind === "unavailable") return unavailable();
    if (user.status === 401) return { ok: false, status: 401, error: "unauthorized" };
    if (user.status !== 200) return user.status === 403 ? forbidden() : unavailable();
    const login = readString(user.body, "login");
    if (!login || !LOGIN_PATTERN.test(login)) return unavailable();

    const permission = await this.call(
      token,
      `/repos/${this.options.repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    if (permission.kind === "unavailable") return unavailable();
    if (permission.status === 401) return { ok: false, status: 401, error: "unauthorized" };
    // GitHub answers 403/404 when the caller cannot see collaborator data: not a writer.
    if (permission.status === 403 || permission.status === 404) return forbidden();
    if (permission.status !== 200) return unavailable();
    const level = readString(permission.body, "permission");
    const role = readString(permission.body, "role_name");
    if ((level && WRITE_PERMISSIONS.has(level)) || (role && WRITE_PERMISSIONS.has(role))) {
      return { ok: true, login };
    }
    return forbidden();
  }

  private async checkPullRequest(token: string, pr: number): Promise<{ ok: true } | GitHubDecision> {
    const cacheKey = String(pr);
    if (this.prCache.get(cacheKey)) return { ok: true };
    const result = await this.call(token, `/repos/${this.options.repo}/pulls/${pr}`);
    if (result.kind === "unavailable") return unavailable();
    if (result.status === 404) return { ok: false, status: 404, error: "pull_request_not_found" };
    if (result.status === 401) return { ok: false, status: 401, error: "unauthorized" };
    if (result.status !== 200) return unavailable();
    this.prCache.set(cacheKey, true);
    return { ok: true };
  }

  private async call(
    token: string,
    path: string,
  ): Promise<{ kind: "response"; status: number; body: unknown } | { kind: "unavailable" }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        // workerd rejects redirect: "error"; manual leaves 3xx as a non-200 that maps to unavailable.
        redirect: "manual",
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      console.error("[pr-evidence] github_request_failed", { path: redactPath(path), error: name });
      return { kind: "unavailable" };
    }
    if (response.status !== 200) {
      if (response.status >= 500) {
        console.error("[pr-evidence] github_upstream_error", { path: redactPath(path), status: response.status });
      }
      await response.body?.cancel();
      return { kind: "response", status: response.status, body: null };
    }
    try {
      return { kind: "response", status: 200, body: await response.json() };
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      console.error("[pr-evidence] github_invalid_json", { path: redactPath(path), error: name });
      return { kind: "unavailable" };
    }
  }
}

function redactPath(path: string): string {
  return path.replace(/\/collaborators\/[^/]+\//, "/collaborators/:login/");
}

function readString(body: unknown, field: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function forbidden(): GitHubDecision {
  return { ok: false, status: 403, error: "forbidden" };
}

function unavailable(): GitHubDecision {
  return { ok: false, status: 503, error: "authorization_unavailable" };
}
