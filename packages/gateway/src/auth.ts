import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { createRateLimiter } from "./security/rate-limiter.js";
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
  markAuthContextReady,
  requireRequestPrincipal,
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
const WS_QUERY_TOKEN_PATHS = ["/ws/voice", "/ws/terminal", "/ws/onboarding", "/ws/vocal"];
const WS_QUERY_TOKEN_PATH_PATTERNS = [/^\/api\/canvases\/[^/]+\/ws$/];

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
  return aBuf.length === bBuf.length && timingSafeEqual(paddedA, paddedB);
}

const rateLimiter = createRateLimiter({
  maxAttempts: 10,
  windowMs: 60_000,
  lockoutMs: 300_000,
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

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    c.req.header("cf-connecting-ip")?.trim() ||
    c.req.header("x-real-ip")?.trim() ||
    forwardedFor ||
    "127.0.0.1"
  );
}

export function authMiddleware(
  token: string | undefined,
  options?: { webhookProviders?: Set<string> },
): MiddlewareHandler {
  const webhookProviders = options?.webhookProviders ?? new Set<string>();

  return async (c, next) => {
    // Original semantics: no MATRIX_AUTH_TOKEN means the gateway runs in
    // open mode (dev convenience). PLATFORM_JWT_SECRET on its own does NOT
    // enforce auth -- it just enables the JWT acceptance path WHEN auth is
    // already required by MATRIX_AUTH_TOKEN. To enforce auth in dev, set
    // MATRIX_AUTH_TOKEN to any value (and optionally PLATFORM_JWT_SECRET to
    // also accept platform-issued JWTs).
    if (!token) return nextWithReady(c, next);

    // Read JWT config + handle per-call so env-var changes during tests
    // are picked up without recreating the middleware.
    const jwtKey = await readJwtKeyConfig();
    const expectedHandle = process.env.MATRIX_HANDLE;

    const normalizedPath = c.req.path;
    if (PUBLIC_PATHS.some((p) => normalizedPath === p) ||
        PUBLIC_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
      return nextWithReady(c, next);
    }

    // App iframe paths are authenticated by app-session cookie middleware,
    // not by bearer token. Exempt them here so the session middleware
    // (mounted separately) is the single verifier.
    if (APP_IFRAME_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
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

    // JWT path: if the bearer looks like a JWT and we have a JWT key, treat
    // JWT validation as terminal. Falling back to the legacy shared-secret
    // path would let an attacker reuse a JWT-shaped token string as the
    // legacy bearer and bypass the JWT verifier entirely.
    if (presentedToken && jwtKey && looksLikeJwt(presentedToken)) {
      try {
        const claims = await validateSyncJwt(presentedToken, {
          ...jwtKey,
          expectedHandle,
        });
        // Stash claims on the Hono context so downstream handlers can
        // resolve the authenticated Clerk userId through the request principal.
        c.set(JWT_CLAIMS_CONTEXT_KEY, claims);
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

    if (legacyHeaderOk || legacyQueryOk) {
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
