import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { z } from "zod/v4";
import { encryptGitHubOAuthState } from "./github-credential-crypto.js";
import type { ServiceAction } from "./types.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_VERSION = "2022-11-28";
const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_RESPONSE_MAX_BYTES = 64 * 1024;
const ACTION_RESPONSE_MAX_BYTES = 1024 * 1024;
const ACTION_REQUEST_MAX_BYTES = 64 * 1024;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export const GITHUB_REQUIRED_SCOPES = ["repo", "notifications"] as const;

export interface GitHubOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: string;
  refreshTokenExpiresAt?: string;
}

export class GitHubOAuthError extends Error {
  constructor() {
    super("GitHub authorization failed");
    this.name = "GitHubOAuthError";
  }
}

export type GitHubApiErrorKind = "unauthorized" | "forbidden" | "rate_limited" | "invalid_response" | "unavailable";

export class GitHubApiError extends Error {
  constructor(readonly kind: GitHubApiErrorKind) {
    super("GitHub request failed");
    this.name = "GitHubApiError";
  }
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.literal("bearer"),
  scope: z.string().max(4_096).optional(),
  expires_in: z.number().int().positive().max(365 * 24 * 60 * 60).optional(),
  refresh_token: z.string().min(1).max(16_384).optional(),
  refresh_token_expires_in: z.number().int().positive().max(2 * 365 * 24 * 60 * 60).optional(),
});
const ViewerSchema = z.object({
  id: z.union([z.number().int().positive().safe(), z.string().regex(/^\d{1,20}$/)]),
  login: z.string().min(1).max(39).regex(/^[A-Za-z0-9-]+$/),
  email: z.email().max(254).nullable(),
});

function normalizeScopes(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))];
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubOAuthError();
  }
  if (!response.body) throw new GitHubOAuthError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes || chunks.length >= 4096) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubOAuthError();
      }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof GitHubOAuthError) throw error;
    throw new GitHubOAuthError();
  } finally {
    reader.releaseLock();
  }
}

export function createGitHubAuthorizationRequest(input: {
  clientId: string;
  callbackUrl: string;
  encryptionKey: Buffer;
  userId: string;
  label?: string;
  redirectTarget: "web" | "mobile";
  now?: Date;
  randomBytes?: (size: number) => Buffer;
}): { url: string } {
  const now = input.now ?? new Date();
  const random = input.randomBytes ?? nodeRandomBytes;
  const codeVerifier = random(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  const state = encryptGitHubOAuthState({
    userId: input.userId,
    ...(input.label ? { label: input.label } : {}),
    redirectTarget: input.redirectTarget,
    codeVerifier,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString(),
  }, input.encryptionKey);
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.callbackUrl);
  url.searchParams.set("scope", GITHUB_REQUIRED_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString() };
}

export class GitHubOAuthClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    fetch?: typeof fetch;
    now?: () => Date;
  }) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GitHubOAuthCredential> {
    const response = await this.requestToken({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code,
      redirect_uri: this.options.callbackUrl,
      code_verifier: codeVerifier,
    });
    return this.toCredential(response);
  }

  async refreshAccessToken(refreshToken: string): Promise<GitHubOAuthCredential> {
    return this.toCredential(await this.requestToken({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }));
  }

  async getViewer(accessToken: string): Promise<{ id: string; login: string; email: string | null }> {
    let response: Response;
    try {
      response = await this.fetchFn("https://api.github.com/user", {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          authorization: `Bearer ${accessToken}`,
          "user-agent": "Matrix-OS",
        },
      });
    } catch {
      throw new GitHubOAuthError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubOAuthError();
    }
    const viewer = ViewerSchema.safeParse(await readBoundedJson(response, PROVIDER_RESPONSE_MAX_BYTES));
    if (!viewer.success) throw new GitHubOAuthError();
    return { id: String(viewer.data.id), login: viewer.data.login, email: viewer.data.email };
  }

  async revokeToken(accessToken: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn(`https://api.github.com/applications/${encodeURIComponent(this.options.clientId)}/token`, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          authorization: `Basic ${Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`, "utf8").toString("base64")}`,
          "content-type": "application/json",
          "user-agent": "Matrix-OS",
        },
        body: JSON.stringify({ access_token: accessToken }),
      });
    } catch {
      throw new GitHubOAuthError();
    }
    if (response.status !== 204 && response.status !== 404) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubOAuthError();
    }
    await response.body?.cancel().catch(() => undefined);
  }

  private async requestToken(body: Record<string, string>): Promise<z.infer<typeof TokenResponseSchema>> {
    let response: Response;
    try {
      response = await this.fetchFn(GITHUB_TOKEN_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GitHubOAuthError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubOAuthError();
    }
    const parsed = TokenResponseSchema.safeParse(await readBoundedJson(response, PROVIDER_RESPONSE_MAX_BYTES));
    if (!parsed.success) throw new GitHubOAuthError();
    return parsed.data;
  }

  private toCredential(token: z.infer<typeof TokenResponseSchema>): GitHubOAuthCredential {
    const now = this.now().getTime();
    return {
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      scopes: normalizeScopes(token.scope),
      ...(token.expires_in ? { expiresAt: new Date(now + token.expires_in * 1000).toISOString() } : {}),
      ...(token.refresh_token_expires_in
        ? { refreshTokenExpiresAt: new Date(now + token.refresh_token_expires_in * 1000).toISOString() }
        : {}),
    };
  }

  async requestApi(input: {
    accessToken: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    url: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    headers?: Readonly<Record<string, string>>;
  }): Promise<unknown> {
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      throw new GitHubApiError("unavailable");
    }
    if (target.protocol !== "https:" || target.hostname !== "api.github.com" || target.port
      || target.username || target.password) throw new GitHubApiError("unavailable");
    for (const [key, value] of Object.entries(input.params ?? {})) target.searchParams.set(key, value);

    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body !== undefined && Buffer.byteLength(body, "utf8") > ACTION_REQUEST_MAX_BYTES) {
      throw new GitHubApiError("unavailable");
    }
    const staticHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      const normalized = name.toLowerCase();
      if (normalized !== "accept" && normalized !== "x-github-api-version") {
        throw new GitHubApiError("unavailable");
      }
      staticHeaders[normalized] = value;
    }

    let response: Response;
    try {
      response = await this.fetchFn(target.toString(), {
        method: input.method,
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        headers: {
          ...staticHeaders,
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          authorization: `Bearer ${input.accessToken}`,
          "user-agent": "Matrix-OS",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError("unavailable");
    }
    if (!response.ok) {
      const rateLimited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
      const kind: GitHubApiErrorKind = response.status === 401
        ? "unauthorized"
        : response.status === 403 && rateLimited
          ? "rate_limited"
          : response.status === 403
            ? "forbidden"
            : rateLimited
              ? "rate_limited"
              : "unavailable";
      await response.body?.cancel().catch(() => undefined);
      throw new GitHubApiError(kind);
    }
    if (response.status === 204) return null;
    try {
      return await readBoundedJson(response, ACTION_RESPONSE_MAX_BYTES);
    } catch {
      throw new GitHubApiError("invalid_response");
    }
  }
}

export async function executeGitHubIntegrationAction(input: {
  client: Pick<GitHubOAuthClient, "requestApi">;
  accessToken: string;
  action: ServiceAction;
  params?: Record<string, unknown>;
}): Promise<{ data: unknown }> {
  const api = input.action.directApi;
  if (!api) throw new GitHubApiError("unavailable");
  let url: string;
  try {
    url = typeof api.url === "function" ? api.url(input.params ?? {}) : api.url;
  } catch {
    throw new GitHubApiError("unavailable");
  }
  return {
    data: await input.client.requestApi({
      accessToken: input.accessToken,
      method: api.method,
      url,
      ...(api.mapParams ? { params: api.mapParams(input.params ?? {}) } : {}),
      ...(api.method === "GET" || api.method === "DELETE"
        ? {}
        : { body: api.mapBody ? api.mapBody(input.params ?? {}) : (input.params ?? {}) }),
      ...(api.staticHeaders ? { headers: api.staticHeaders } : {}),
    }),
  };
}
