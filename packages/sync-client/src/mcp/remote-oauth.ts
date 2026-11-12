/**
 * Matrix OAuth for the hosted `/mcp` resource (spec 2691, `matrix mcp login`).
 *
 * OAuth 2.1 authorization code + PKCE (S256) with a loopback redirect
 * (RFC 8252) and dynamic client registration. Tokens are audience-bound to
 * the `/mcp` resource (RFC 8707 `resource`) and kept per CLI profile in an
 * owner-only file. The CLI's platform login token is never sent to `/mcp`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "../lib/atomic-write.js";
import { profilePath } from "../lib/profiles.js";
import { withProfileRefreshLock } from "./remote-oauth-lock.js";

const HTTP_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 64 * 1024;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Refresh this long before expiry so a request never starts on a dying token. */
export const REFRESH_MARGIN_MS = 60_000;

export const RemoteMcpTokensSchema = z.object({
  version: z.literal(1),
  resource: z.url().max(2048),
  issuer: z.url().max(2048),
  tokenEndpoint: z.url().max(2048),
  clientId: z.string().min(1).max(256),
  accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384).optional(),
  expiresAt: z.number().int().nonnegative(),
}).strict();
export type RemoteMcpTokens = z.infer<typeof RemoteMcpTokensSchema>;

export class RemoteMcpAuthError extends Error {
  constructor(readonly code: "login_required" | "oauth_failed" | "invalid_resource" | "profile_changed", message: string) {
    super(message);
    this.name = "RemoteMcpAuthError";
  }
}

const loginRequired = () => new RemoteMcpAuthError("login_required", "Matrix MCP sign-in is required. Run `matrix mcp login` first.");
const profileChanged = () => new RemoteMcpAuthError("profile_changed", "Matrix MCP profile login changed; restart the bridge.");
const oauthFailed = () => new RemoteMcpAuthError("oauth_failed", "Matrix MCP sign-in failed. Run `matrix mcp login` again.");

/** https everywhere; plain http only on loopback (local development and tests). */
export function trustedUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash) {
    throw new RemoteMcpAuthError("invalid_resource", "Matrix MCP URL must use https.");
  }
  return url;
}

export function remoteMcpTokenPath(profileName: string, configDir?: string): string {
  return join(profilePath(profileName, configDir), "mcp-oauth.json");
}

export async function loadRemoteMcpTokens(profileName: string, configDir?: string): Promise<RemoteMcpTokens | null> {
  try {
    return RemoteMcpTokensSchema.parse(JSON.parse(await readFile(remoteMcpTokenPath(profileName, configDir), "utf8")));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveRemoteMcpTokens(profileName: string, tokens: RemoteMcpTokens, configDir?: string): Promise<void> {
  const path = remoteMcpTokenPath(profileName, configDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeUtf8FileAtomic(path, JSON.stringify(RemoteMcpTokensSchema.parse(tokens), null, 2), 0o600);
}

export async function clearRemoteMcpTokens(profileName: string, configDir?: string): Promise<void> {
  try { await unlink(remoteMcpTokenPath(profileName, configDir)); }
  catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** Streams at most MAX_METADATA_BYTES; cancels the body the moment it would exceed the cap. */
async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_METADATA_BYTES || !response.body) { await response.body?.cancel(); throw oauthFailed(); }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(MAX_METADATA_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_METADATA_BYTES - length) {
        await reader.cancel();
        throw oauthFailed();
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
  catch (error: unknown) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw oauthFailed();
    throw error;
  }
}

/** Parses only 2xx bodies; any other status is returned without reading its (possibly non-JSON) body. */
async function request(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(trustedUrl(url).href, { ...init, redirect: "error", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    return { status: response.status, body: undefined };
  }
  return { status: response.status, body: await boundedJson(response) };
}

const ResourceMetadata = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1).max(8) }).passthrough();
const ServerMetadata = z.object({
  issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(),
  registration_endpoint: z.string().optional(), code_challenge_methods_supported: z.array(z.string()).optional(),
}).passthrough();
const TokenResponse = z.object({
  access_token: z.string().min(1).max(16_384), token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().int().positive().max(366 * 24 * 3600).optional(), refresh_token: z.string().min(1).max(16_384).optional(),
}).passthrough();

/** RFC 9728 then RFC 8414 (falling back to OpenID) discovery; every endpoint must be https (or loopback http). */
export async function discoverRemoteMcpAuthorizationServer(resource: URL, fetchImpl: typeof fetch = fetch) {
  const protectedResource = await request(fetchImpl, `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`);
  const metadata = ResourceMetadata.safeParse(protectedResource.body);
  if (protectedResource.status !== 200 || !metadata.success || metadata.data.resource !== resource.href) throw oauthFailed();
  const issuer = trustedUrl(metadata.data.authorization_servers[0]!);
  const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname;
  for (const wellKnown of [`/.well-known/oauth-authorization-server${issuerPath}`, `${issuerPath}/.well-known/openid-configuration`]) {
    const found = await request(fetchImpl, `${issuer.origin}${wellKnown}`);
    const parsed = ServerMetadata.safeParse(found.body);
    if (found.status !== 200 || !parsed.success) continue;
    if (parsed.data.issuer !== issuer.href.replace(/\/$/, "") && parsed.data.issuer !== issuer.href) throw oauthFailed();
    if (parsed.data.code_challenge_methods_supported && !parsed.data.code_challenge_methods_supported.includes("S256")) throw oauthFailed();
    for (const endpoint of [parsed.data.authorization_endpoint, parsed.data.token_endpoint, parsed.data.registration_endpoint]) {
      if (endpoint) trustedUrl(endpoint);
    }
    if (!parsed.data.registration_endpoint) throw oauthFailed();
    return { ...parsed.data, registration_endpoint: parsed.data.registration_endpoint };
  }
  throw oauthFailed();
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One loopback callback, then close; bounded by the login timeout. */
async function loopbackCallback(state: string, timeoutMs: number): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  let settle: { resolve(code: string): void; reject(error: Error): void } | undefined;
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const returned = url.searchParams.get("code");
    const ok = returned && returned.length <= 4096 && safeEqual(url.searchParams.get("state") ?? "", state);
    res.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(ok ? "Matrix MCP sign-in is complete. You can close this tab." : "Matrix MCP sign-in failed. Return to the terminal.");
    if (ok) settle!.resolve(returned); else settle!.reject(oauthFailed());
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const timer = setTimeout(() => settle!.reject(new RemoteMcpAuthError("oauth_failed", "Matrix MCP sign-in timed out.")), timeoutMs);
  timer.unref();
  const close = () => { clearTimeout(timer); server.close(); server.closeAllConnections(); };
  return { redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`, code, close };
}

function tokensFrom(body: unknown, base: Omit<RemoteMcpTokens, "accessToken" | "refreshToken" | "expiresAt" | "version">,
  previousRefresh?: string): RemoteMcpTokens {
  const parsed = TokenResponse.safeParse(body);
  if (!parsed.success) throw oauthFailed();
  return { version: 1, ...base, accessToken: parsed.data.access_token,
    ...(parsed.data.refresh_token ?? previousRefresh ? { refreshToken: parsed.data.refresh_token ?? previousRefresh } : {}),
    expiresAt: Date.now() + (parsed.data.expires_in ?? 3600) * 1000 };
}

export async function loginRemoteMcp(options: {
  resource: string; profileName: string; configDir?: string;
  openBrowser(url: string): void | Promise<void>; fetch?: typeof fetch; timeoutMs?: number;
}): Promise<RemoteMcpTokens> {
  const fetchImpl = options.fetch ?? fetch;
  const resource = trustedUrl(options.resource);
  const server = await discoverRemoteMcpAuthorizationServer(resource, fetchImpl);
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const callback = await loopbackCallback(state, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    const registered = await request(fetchImpl, server.registration_endpoint, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Matrix CLI MCP bridge", redirect_uris: [callback.redirectUri],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
    const clientId = z.object({ client_id: z.string().min(1).max(256) }).passthrough().safeParse(registered.body);
    if (registered.status < 200 || registered.status >= 300 || !clientId.success) throw oauthFailed();
    const authorize = new URL(trustedUrl(server.authorization_endpoint));
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId.data.client_id,
      redirect_uri: callback.redirectUri, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", state, scope: "matrix:computer", resource: resource.href })) authorize.searchParams.set(key, value);
    // Await both together so a callback that fails while the browser step runs is never unhandled.
    const [code] = await Promise.all([callback.code, options.openBrowser(authorize.href)]);
    const exchanged = await request(fetchImpl, server.token_endpoint, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callback.redirectUri,
        client_id: clientId.data.client_id, code_verifier: verifier, resource: resource.href }).toString() });
    if (exchanged.status !== 200) throw oauthFailed();
    const tokens = tokensFrom(exchanged.body, { resource: resource.href, issuer: server.issuer,
      tokenEndpoint: server.token_endpoint, clientId: clientId.data.client_id });
    await saveRemoteMcpTokens(options.profileName, tokens, options.configDir);
    return tokens;
  } finally { callback.close(); }
}

/** Refresh-token grant; keeps the previous refresh token when the server does not rotate it. */
export async function refreshRemoteMcpTokens(tokens: RemoteMcpTokens, fetchImpl: typeof fetch = fetch): Promise<RemoteMcpTokens> {
  if (!tokens.refreshToken) throw loginRequired();
  const refreshed = await request(fetchImpl, tokens.tokenEndpoint, { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refreshToken,
      client_id: tokens.clientId, resource: tokens.resource }).toString() });
  if (refreshed.status !== 200) throw loginRequired();
  return tokensFrom(refreshed.body, { resource: tokens.resource, issuer: tokens.issuer,
    tokenEndpoint: tokens.tokenEndpoint, clientId: tokens.clientId }, tokens.refreshToken);
}

/**
 * The bridge's token source: refreshes before expiry and once after a 401.
 * Refreshes are single-flight in-process and serialized across processes by
 * a profile lock; the saved tokens are reread under the lock and again after
 * a failed refresh, so a token another bridge already rotated is adopted
 * rather than spending this process's stale refresh token.
 */
export function createRemoteMcpTokenSource(options: { profileName: string; configDir?: string; fetch?: typeof fetch; now?: () => number }) {
  const now = options.now ?? Date.now;
  let current: RemoteMcpTokens | null = null;
  let refreshing: Promise<RemoteMcpTokens> | null = null;
  const usable = (tokens: RemoteMcpTokens | null, stale: RemoteMcpTokens): tokens is RemoteMcpTokens =>
    Boolean(tokens && tokens.accessToken !== stale.accessToken && tokens.expiresAt - REFRESH_MARGIN_MS > now());
  // The bridge is bound to the login it started with: a different resource,
  // issuer, or client saved later (another `matrix mcp login --url`) is never used.
  let binding: Pick<RemoteMcpTokens, "resource" | "issuer" | "clientId"> | null = null;
  const bound = (tokens: RemoteMcpTokens | null): RemoteMcpTokens | null => {
    if (tokens && binding && (tokens.resource !== binding.resource || tokens.issuer !== binding.issuer
      || tokens.clientId !== binding.clientId)) throw profileChanged();
    return tokens;
  };
  const reread = async () => bound(await loadRemoteMcpTokens(options.profileName, options.configDir));
  const refresh = (stale: RemoteMcpTokens) => refreshing ??= (async () => {
    try {
      current = await withProfileRefreshLock(`${remoteMcpTokenPath(options.profileName, options.configDir)}.lock`, async () => {
        const saved = await reread();
        if (usable(saved, stale)) return saved;
        const base = saved ?? stale;
        let next: RemoteMcpTokens;
        try { next = await refreshRemoteMcpTokens(base, options.fetch); }
        catch (error: unknown) {
          // A spent refresh token (invalid_grant) may mean another process already rotated it.
          const after = await reread();
          if (usable(after, stale)) return after;
          throw error;
        }
        await saveRemoteMcpTokens(options.profileName, next, options.configDir);
        return next;
      });
      return current;
    } finally { refreshing = null; }
  })();
  return {
    async load(): Promise<RemoteMcpTokens> {
      current ??= await loadRemoteMcpTokens(options.profileName, options.configDir);
      if (!current) throw loginRequired();
      binding ??= { resource: current.resource, issuer: current.issuer, clientId: current.clientId };
      return current;
    },
    async accessToken(): Promise<string> {
      const tokens = await this.load();
      return tokens.expiresAt - REFRESH_MARGIN_MS > now() ? tokens.accessToken : (await refresh(tokens)).accessToken;
    },
    /** After a 401: refresh unless another request already replaced the rejected token. */
    async afterRejected(rejected: string): Promise<string> {
      const tokens = await this.load();
      return tokens.accessToken !== rejected ? tokens.accessToken : (await refresh(tokens)).accessToken;
    },
  };
}
