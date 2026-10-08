import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import {
  PREVIEW_TERMINAL_ACCESS_HEADER,
  PREVIEW_TERMINAL_OWNER_CONTEXT_KEY,
  verifyPreviewTerminalAccess,
} from "./preview-terminal-access.js";
import { createRateLimiter } from "./security/rate-limiter.js";
import { resolveHermesIntegrationCapability } from "./chat/hermes-integration-capability.js";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "./chat/matrix-mcp-launch.js";
import {
  looksLikeJwt,
  readJwtKeyConfig,
  validateSyncJwt,
} from "./auth-jwt.js";
import {
  AUTH_CONTEXT_READY_CONTEXT_KEY,
  InvalidRequestPrincipalError,
  JWT_CLAIMS_CONTEXT_KEY,
  MissingRequestPrincipalError,
  SAFE_PRINCIPAL_USER_ID,
  markAuthContextReady,
  markVerifiedRuntimeBearer,
  requireRequestPrincipal,
  setPlatformVerifiedPrincipal,
} from "./request-principal.js";

export { AUTH_CONTEXT_READY_CONTEXT_KEY, JWT_CLAIMS_CONTEXT_KEY, markAuthContextReady };

export class MissingSyncUserIdentityError extends Error {
  constructor() {
    super("Missing authenticated sync user identity");
    this.name = "MissingSyncUserIdentityError";
  }
}

/**
 * Compatibility resolver for older sync call sites that still need only the
 * user id string. New protected routes should use request-principal helpers
 * directly so they preserve source and typed failure information.
 *
 * Do not add new route-handler calls to this wrapper; keep it only as a
 * migration target for remaining legacy compatibility.
 */
export function getUserIdFromContext(c: Context): string {
  const configuredUserId = process.env.MATRIX_USER_ID ?? process.env.MATRIX_HANDLE;
  try {
    return requireRequestPrincipal(c, {
      configuredUserId,
      isTrustedSingleUserGateway: Boolean(configuredUserId),
      requireAuthContextReady: false,
    }).userId;
  } catch (err: unknown) {
    if (err instanceof MissingRequestPrincipalError || err instanceof InvalidRequestPrincipalError) {
      console.error("[auth] Missing or invalid request principal for legacy user id compatibility");
      throw new MissingSyncUserIdentityError();
    }
    throw err;
  }
}

async function nextWithReady(c: Context, next: () => Promise<void>): Promise<void> {
  markAuthContextReady(c);
  await next();
}

function unauthorized(c: Context) {
  markAuthContextReady(c);
  return c.json({ error: "Unauthorized" }, 401);
}

function tooManyRequests(c: Context) {
  markAuthContextReady(c);
  return c.json({ error: "Too many requests" }, 429);
}

const PUBLIC_PATHS = ["/health", "/api/integrations/available"];
const PUBLIC_PREFIXES = [
  "/icons/",
  "/files/system/icons/",
];
// Paths that are authenticated by app-session cookie (HMAC-signed per-slug
// cookie) rather than bearer token. authMiddleware exempts these by calling
// next() without setting a principal. The app-session middleware (mounted
// separately on this prefix) is the single verifier for these requests.
// Single prefix -- no /files/apps/ entry because iframe navigation uses
// /apps/:slug/* after spec 063.
const APP_IFRAME_PREFIXES = ["/apps/"];
// Paths that authenticate by HMAC signature rather than bearer token.
// They bypass bearer auth but MUST still pass through a rate limiter --
// HMAC verification is not cheap enough to absorb a flood, and invalid
// signatures should throttle the source IP just like invalid bearer
// tokens do. Integrations webhook and voice webhooks live here.
const HMAC_WEBHOOK_PREFIXES = [
  "/api/integrations/webhook/",
];
// These endpoints own bearer validation in their route handlers because they
// use service-specific tokens instead of the user/session MATRIX_AUTH_TOKEN.
const ROUTE_SCOPED_BEARER_PATHS = [
  "/api/internal/upgrade",
  "/api/internal/platform-speech/config",
];
const ROUTE_SCOPED_SIGNATURE_PATHS = [
  "/api/internal/terminal-acceptance/run",
];
const COLLABORATION_HTTP_PREFIX = "/api/collaboration/";
const COLLABORATION_WEBSOCKET_PATH =
  /^\/ws\/collaboration\/(?:direct\/)?scopes\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:events|terminal)$/;
const MESSAGE_APPSERVICE_PREFIX = "/api/messages/appservice/";
const MESSAGE_HERMES_REPLY_PATH = /^\/api\/messages\/conversations\/[^/]+\/reply$/;
const WS_QUERY_TOKEN_PATHS = [
  "/ws/chats/events",
  "/ws",
  "/ws/terminal/tab",
  "/ws/onboarding",
];
const WS_QUERY_TOKEN_PATH_PATTERNS = [
  /^\/api\/canvases\/[^/]+\/ws$/,
  /^\/ws\/coding-agents\/thread\/thread_[A-Za-z0-9_-]+$/,
];

/**
 * `/ws/chats/:chatId/voice/:sessionId` — ticket-authenticated voice transport.
 * Bound to safe bounded ids; never joins the generic query-token allowlist.
 */
const VOICE_TRANSPORT_WS_PATH = /^\/ws\/chats\/[A-Za-z0-9_-]{1,160}\/voice\/[A-Za-z0-9_-]{1,160}$/;

// Constant-time string compare. Previously, the length-mismatch branch ran
// timingSafeEqual(bufB, bufB) as a dummy call -- but the work done in
// timingSafeEqual is proportional to bufB.length, not bufA.length. An
// attacker varying the submitted token length could time-distinguish the
// "wrong length" branch from the "right length, wrong content" branch,
// leaking a 1-bit length oracle that gradually reveals the correct token
// length over many probes. Pad both sides to the same max length so
// timingSafeEqual always does the same amount of work, then require the
// original lengths to match so a correct prefix plus trailing garbage fails.
function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  const maxLen = Math.max(aBuf.length, bBuf.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  aBuf.copy(paddedA);
  bBuf.copy(paddedB);
  const equal = timingSafeEqual(paddedA, paddedB);
  return aBuf.length === bBuf.length && equal;
}

function readPlatformVerifiedUserId(c: Context, token: string): string | undefined {
  const userId = c.req.header("x-platform-user-id");
  const proof = c.req.header("x-platform-verified");
  if (!userId || !proof || !SAFE_PRINCIPAL_USER_ID.test(userId)) return undefined;
  const expected = createHmac("sha256", token).update(userId).digest("hex");
  return timingSafeCompare(proof, expected) ? userId : undefined;
}

function isPreviewTerminalPath(path: string): boolean {
  return path.startsWith("/api/terminal/") || path === "/ws/terminal/tab";
}

export function readPreviewTerminalOwner(c: Pick<Context, "get">): string | undefined {
  return c.get(PREVIEW_TERMINAL_OWNER_CONTEXT_KEY as never) as string | undefined;
}

const rateLimiter = createRateLimiter({
  maxAttempts: 10,
  windowMs: 60_000,
  lockoutMs: 300_000,
});

const previewMcpProjectionRateLimiter = createRateLimiter({
  maxAttempts: 120,
  windowMs: 60_000,
  lockoutMs: 30_000,
});

// Dedicated limiter for HMAC-authenticated webhook paths. Legit providers
// (Pipedream, Twilio, ElevenLabs) retry on failure so the ceiling has to
// tolerate bursts, but we still need a hard cap -- without one, HMAC
// verification work becomes a free DoS surface. 120 req/min per source
// IP covers "provider retrying a stuck delivery" without making the
// endpoint a flood target. Lockout is short (30s) because a banned
// legitimate provider just gets delayed, not permanently silenced.
const webhookRateLimiter = createRateLimiter({
  maxAttempts: 120,
  windowMs: 60_000,
  lockoutMs: 30_000,
});

// The preview-only acceptance transport uploads two bounded probe assets in
// signed chunks before running two lifecycle commands. It therefore needs a
// short valid burst larger than the generic failed-auth ceiling, and must not
// inherit a lockout caused by unrelated requests sharing a proxy source IP.
// Keep HMAC verification bounded independently at 64 requests per minute.
const acceptanceSignatureRateLimiter = createRateLimiter({
  maxAttempts: 64,
  windowMs: 60_000,
  lockoutMs: 30_000,
});

// ---------------------------------------------------------------------------
// Trusted-proxy client-IP resolution
//
// Rate limiters below key on the caller's IP. Forwarded headers
// (CF-Connecting-IP, X-Real-IP, X-Forwarded-For) are client-controlled unless
// a reverse proxy overwrites them, so they are honored ONLY when the direct
// transport peer is listed in MATRIX_TRUSTED_PROXIES (comma-separated
// IPs/CIDRs — e.g. "127.0.0.1,::1" for the on-host nginx hop that fronts
// every customer-VPS gateway). With no proxies configured, or when the peer
// is not listed, every forwarded header is ignored and the socket peer is the
// limiter key.
// ---------------------------------------------------------------------------

/** Narrow shape so tests can drive the resolver without a full Context. */
interface ClientIpContext {
  env?: unknown;
  req: {
    path: string;
    header: (name: string) => string | undefined;
  };
}

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Parse IPv6 (incl. `::` compression and a dotted-quad tail) to a bigint. */
function ipv6ToBigInt(ip: string): bigint | null {
  let input = ip.toLowerCase();
  const lastColon = input.lastIndexOf(":");
  const tail = lastColon >= 0 ? input.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    const mapped = ipv4ToLong(tail);
    if (mapped === null) return null;
    input = `${input.slice(0, lastColon)}:${(mapped >>> 16).toString(16)}:${(mapped & 0xffff).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (text: string): number[] | null => {
    if (text.length === 0) return [];
    const out: number[] = [];
    for (const piece of text.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const left = parseHalf(halves[0] ?? "");
  const right = halves.length === 2 ? parseHalf(halves[1] ?? "") : [];
  if (left === null || right === null) return null;
  let hextets: number[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    hextets = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    if (left.length !== 8) return null;
    hextets = left;
  }
  let value = 0n;
  for (const hextet of hextets) value = (value << 16n) | BigInt(hextet);
  return value;
}

/** Collapse IPv4-mapped IPv6 forms so v4 proxy entries match dual-stack peers. */
function normalizePeerAddress(peer: string): string {
  const lower = peer.toLowerCase();
  if (!lower.startsWith("::ffff:")) return peer;
  const tail = lower.slice(7);
  if (ipv4ToLong(tail) !== null) return tail;
  const parsed = ipv6ToBigInt(lower);
  if (parsed === null || parsed < 0xffff00000000n || parsed > 0xffffffffffffn) return peer;
  const value = Number(parsed & 0xffffffffn);
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function proxyEntryMatches(entry: string, peer: string): boolean {
  const slash = entry.indexOf("/");
  const base = (slash >= 0 ? entry.slice(0, slash) : entry).trim();
  const bits = slash >= 0 ? Number.parseInt(entry.slice(slash + 1).trim(), 10) : null;
  const peerV4 = ipv4ToLong(peer);
  const baseV4 = ipv4ToLong(base);
  if (peerV4 !== null && baseV4 !== null) {
    const prefix = bits ?? 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (peerV4 & mask) === (baseV4 & mask);
  }
  const peerV6 = ipv6ToBigInt(peer);
  const baseV6 = ipv6ToBigInt(base);
  if (peerV6 === null || baseV6 === null) return false;
  const prefix = bits ?? 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
  const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) & ~((1n << BigInt(128 - prefix)) - 1n);
  return (peerV6 & mask) === (baseV6 & mask);
}

/** Read per call so env changes take effect without recreating middleware. */
function isTrustedProxyPeer(peer: string): boolean {
  const configured = process.env.MATRIX_TRUSTED_PROXIES;
  if (!configured) return false;
  for (const raw of configured.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0 || entry.length > 64) continue;
    if (proxyEntryMatches(entry, peer)) return true;
  }
  return false;
}

let warnedPeerResolutionFailure = false;

function transportPeerAddress(c: ClientIpContext): string | undefined {
  try {
    const remote = getConnInfo(c as Context).remote.address;
    return typeof remote === "string" && isIP(remote) !== 0 ? remote : undefined;
  } catch (error: unknown) {
    if (!(error instanceof TypeError) && !warnedPeerResolutionFailure) {
      warnedPeerResolutionFailure = true;
      console.warn(
        "[auth] transport peer resolution failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    return undefined;
  }
}

function getClientIp(c: ClientIpContext): string {
  const peer = transportPeerAddress(c);
  if (peer !== undefined) {
    const normalized = normalizePeerAddress(peer);
    if (isTrustedProxyPeer(normalized)) {
      const forwarded =
        c.req.header("x-real-ip")?.trim() ||
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
        c.req.header("cf-connecting-ip")?.trim();
      return forwarded !== undefined && isIP(forwarded) !== 0 ? forwarded : normalized;
    }
    return normalized;
  }
  // Fail closed: when the transport peer is unresolvable (e.g. a non-node
  // adapter or a test harness), requests share a per-path sentinel bucket —
  // never an attacker-chosen header value.
  return `unresolved-transport-peer:${c.req.path}`;
}

function getTrustedProxyClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  // Customer-VPS nginx always overwrites X-Real-IP with its transport peer.
  // CF-Connecting-IP is intentionally excluded because direct callers can
  // supply it and rotate the signature-verification limiter key.
  return c.req.header("x-real-ip")?.trim() || "trusted-proxy-address-unavailable";
}

export function authMiddleware(
  token: string | undefined,
  options?: {
    webhookProviders?: Set<string>;
    resolveMatrixMcpCapability?: (token: string, method: string, path: string) => string | null;
    resolveMatrixMcpRunContext?: (token: string, method: string, path: string) => MatrixMcpRunContext | null;
  },
): MiddlewareHandler {
  const webhookProviders = options?.webhookProviders ?? new Set<string>();

  return async (c, next) => {
    const setTerminalAccess = (actorId: string) => {
      if (!token || !isPreviewTerminalPath(c.req.path)) return;
      const ownerId = verifyPreviewTerminalAccess({
        value: c.req.header(PREVIEW_TERMINAL_ACCESS_HEADER),
        key: token,
        actorId,
        configuredOwnerIds: [process.env.MATRIX_USER_ID, process.env.MATRIX_CLERK_USER_ID],
        runtimeSlot: process.env.MATRIX_RUNTIME_SLOT,
      });
      if (ownerId) c.set(PREVIEW_TERMINAL_OWNER_CONTEXT_KEY, ownerId);
    };
    // Read JWT config + handle per-call so env-var changes during tests
    // are picked up without recreating the middleware.
    const jwtKey = await readJwtKeyConfig();
    const expectedHandle = process.env.MATRIX_HANDLE;
    const expectedRuntimeSlot = process.env.MATRIX_RUNTIME_SLOT;

    const normalizedPath = c.req.path;
    if ((c.req.method === "GET" && /^\/api\/share\/chats\/[a-f0-9]{64}$/.test(normalizedPath)) || PUBLIC_PATHS.some((p) => normalizedPath === p) ||
        PUBLIC_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
      return nextWithReady(c, next);
    }

    // App iframe paths are authenticated by app-session cookie middleware,
    // not by bearer token. Exempt them here so the session middleware
    // (mounted separately) is the single verifier.
    if (APP_IFRAME_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
      return nextWithReady(c, next);
    }

    // Matrix bridge/appservice callbacks and Hermes reply delivery use scoped
    // internal tokens checked by their route handlers. Bypass bearer auth only
    // for those token-bearing paths, while still rate-limiting failed attempts.
    const hasHermesReplyToken = Boolean(c.req.header("X-Matrix-OS-Hermes-Capability"));
    if (normalizedPath.startsWith(MESSAGE_APPSERVICE_PREFIX) || (MESSAGE_HERMES_REPLY_PATH.test(normalizedPath) && hasHermesReplyToken)) {
      const ip = getClientIp(c);
      if (!webhookRateLimiter.check(ip)) {
        return tooManyRequests(c);
      }
      return nextWithReady(c, next);
    }

    // HMAC-authenticated paths (Pipedream integrations webhook): bypass
    // bearer auth but still run through a dedicated webhook rate limiter,
    // so HMAC verification can't become a free DoS target. The route
    // handler validates the signature and returns 401 on mismatch; the
    // rate limiter here protects the verification work itself.
    if (HMAC_WEBHOOK_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
      const ip = getClientIp(c);
      if (!webhookRateLimiter.check(ip)) {
        return tooManyRequests(c);
      }
      return nextWithReady(c, next);
    }

    // Platform-proxied collaboration routes carry a scoped, short-lived actor
    // proof (and, where required, a signed rollout policy). Requiring the
    // owner's MATRIX_AUTH_TOKEN here would reject every collaborator before
    // those route-specific verifiers can run. Their bounded proof decoder and
    // verifier rate-limit each authenticated actor independently; applying a
    // transport-address quota here would let one collaborator block the rest.
    if (normalizedPath.startsWith(COLLABORATION_HTTP_PREFIX)
      || COLLABORATION_WEBSOCKET_PATH.test(normalizedPath)) {
      return nextWithReady(c, next);
    }

    if (ROUTE_SCOPED_BEARER_PATHS.some((p) => normalizedPath === p)) {
      const ip = getClientIp(c);
      if (!rateLimiter.check(ip)) {
        return tooManyRequests(c);
      }
      return nextWithReady(c, next);
    }

    // A disposable Preview VPS may delegate only MCP projection to its
    // PR-tagged staging broker. The projection handler validates that separate
    // bearer and owner ID; the ordinary runtime token remains required for all
    // other routes.
    if (process.env.MATRIX_PREVIEW_RUNTIME === 'true'
      && process.env.MATRIX_PREVIEW_CUSTOM_MCP_TOKEN
      && (normalizedPath === '/api/internal/mcp-projection'
        || normalizedPath.startsWith('/api/internal/mcp-projection/'))) {
      const ip = getClientIp(c);
      if (!previewMcpProjectionRateLimiter.check(ip)) return tooManyRequests(c);
      return nextWithReady(c, next);
    }

    if (ROUTE_SCOPED_SIGNATURE_PATHS.some((p) => normalizedPath === p)) {
      const ip = getTrustedProxyClientIp(c);
      if (!acceptanceSignatureRateLimiter.check(ip)) {
        return tooManyRequests(c);
      }
      return nextWithReady(c, next);
    }

    // Voice webhook paths use provider-level HMAC verification, not bearer
    // token auth. Only bypass auth for providers that are actually
    // registered and active. Uses the stricter "failed auth" rate limiter
    // because the provider allowlist is narrow and a hit from an unknown
    // provider is already suspicious.
    const webhookMatch = normalizedPath.match(/^\/voice\/webhook\/([a-z0-9-]+)$/);
    const isWebhook = webhookMatch && webhookProviders.has(webhookMatch[1]);
    if (isWebhook) {
      const ip = getClientIp(c);
      if (!rateLimiter.check(ip)) {
        return tooManyRequests(c);
      }
      return nextWithReady(c, next);
    }

    // Dedicated voice transport: the WebSocket upgrade carries a one-time,
    // path-bound ticket — not a bearer token. The route verifier performs
    // Origin allowlist, constant-time digest check, atomic consume, and
    // chat/session/principal/epoch binding before any session mutation, so
    // bearer auth must not run first. Still IP rate-limited here on the
    // trusted-proxy-gated source key (socket peer unless MATRIX_TRUSTED_PROXIES
    // lists it), so callers cannot rotate spoofed forwarding headers to dodge
    // the limiter.
    if (VOICE_TRANSPORT_WS_PATH.test(normalizedPath)) {
      const ip = getClientIp(c);
      if (!rateLimiter.check(ip)) {
        return tooManyRequests(c);
      }
      return nextWithReady(c, next);
    }

    if (!token) {
      if (process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV === "1") {
        return nextWithReady(c, next);
      }
      console.error("[auth] MATRIX_AUTH_TOKEN is not configured; rejecting protected request");
      return unauthorized(c);
    }

    const authHeader = c.req.header("Authorization");
    const isWsUpgrade =
      WS_QUERY_TOKEN_PATHS.some((p) => normalizedPath === p) ||
      WS_QUERY_TOKEN_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));

    // Only accept query param token for WebSocket upgrades (browsers can't set
    // Authorization headers on WS connections). REST endpoints must use headers.
    let queryToken: string | null = null;
    if (isWsUpgrade) {
      try {
        queryToken = new URL(c.req.url).searchParams.get("token");
      } catch (err: unknown) {
        if (!(err instanceof TypeError)) {
          console.error("[auth] Unexpected error parsing WS URL:", err);
        }
      }
    }

    const presentedToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : isWsUpgrade && queryToken
        ? queryToken
        : null;

    if (presentedToken) {
      const matrixMcpContext = options?.resolveMatrixMcpRunContext?.(presentedToken, c.req.method, normalizedPath);
      const matrixMcpActor = matrixMcpContext?.actorId
        ?? (!options?.resolveMatrixMcpRunContext
          ? options?.resolveMatrixMcpCapability?.(presentedToken, c.req.method, normalizedPath)
          : null);
      if (matrixMcpActor) {
        if (c.req.header("x-platform-user-id") || c.req.header("x-platform-verified")) return unauthorized(c);
        setPlatformVerifiedPrincipal(c, matrixMcpActor);
        c.set(MATRIX_MCP_RUN_CONTEXT_KEY as never, matrixMcpContext ?? { actorId: matrixMcpActor });
        return nextWithReady(c, next);
      }
      // Scope checks use the raw URL path. Hono may decode percent-encoded
      // aliases before routing, which must not grant a recipe bearer access.
      const hermesActor = resolveHermesIntegrationCapability(presentedToken, c.req.method,
        new URL(c.req.raw.url).pathname);
      if (hermesActor) {
        // This run-scoped bearer carries its own actor; caller-supplied
        // platform identity headers are never accepted with it.
        if (c.req.header("x-platform-user-id") || c.req.header("x-platform-verified")) return unauthorized(c);
        setPlatformVerifiedPrincipal(c, hermesActor);
        return nextWithReady(c, next);
      }
    }

    // JWT path: if the bearer looks like a JWT and we have a JWT key, treat
    // JWT validation as terminal. Falling back to the legacy shared-secret
    // path would let an attacker reuse a JWT-shaped token string as the
    // legacy bearer and bypass the JWT verifier entirely.
    if (presentedToken && jwtKey && looksLikeJwt(presentedToken)) {
      try {
        const claims = await validateSyncJwt(presentedToken, {
          ...jwtKey,
          expectedHandle,
          expectedRuntimeSlot,
        });
        // Stash claims on the Hono context so downstream handlers can
        // resolve the authenticated Clerk userId through the request principal.
        c.set(JWT_CLAIMS_CONTEXT_KEY, claims);
        markVerifiedRuntimeBearer(c);
        setTerminalAccess(claims.sub);
        return nextWithReady(c, next);
      } catch (err) {
        // Fall through. We don't expose JWT failure reasons to the client,
        // but a debug log here prevents a misconfigured PLATFORM_JWT_SECRET
        // from silently locking out every platform-issued token with zero
        // operator signal.
        console.warn(
          "[auth] JWT validation failed:",
          (err as Error).message,
        );
        const ip = getClientIp(c);
        if (!rateLimiter.check(ip)) {
          return tooManyRequests(c);
        }
        return unauthorized(c);
      }
    }

    const legacyHeaderOk =
      token && authHeader && timingSafeCompare(authHeader, `Bearer ${token}`);
    const legacyQueryOk =
      token && isWsUpgrade && queryToken && timingSafeCompare(queryToken, token);

    if (legacyHeaderOk) {
      markVerifiedRuntimeBearer(c);
      const platformUserId = readPlatformVerifiedUserId(c, token);
      if (platformUserId) {
        setPlatformVerifiedPrincipal(c, platformUserId);
        setTerminalAccess(platformUserId);
      }
      return nextWithReady(c, next);
    }

    if (legacyQueryOk) {
      return nextWithReady(c, next);
    }

    // Only rate-limit failed auth attempts
    const ip = getClientIp(c);
    if (!rateLimiter.check(ip)) {
      return tooManyRequests(c);
    }

    return unauthorized(c);
  };
}
