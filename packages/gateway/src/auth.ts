import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { createRateLimiter } from "./security/rate-limiter.js";
import {
  looksLikeJwt,
  readJwtKeyConfig,
  validateSyncJwt,
  type SyncJwtClaims,
} from "./auth-jwt.js";

// Hono context key for a validated sync JWT's claims. Routes that need the
// authenticated Clerk userId read `c.get("jwtClaims")?.sub`. See
// `getUserIdFromContext` below for the canonical helper.
export const JWT_CLAIMS_CONTEXT_KEY = "jwtClaims";

export class MissingSyncUserIdentityError extends Error {
  constructor() {
    super("Missing authenticated sync user identity");
    this.name = "MissingSyncUserIdentityError";
  }
}

/**
 * Canonical resolver for the "who is this request for?" question used by
 * sync routes. Prefers the Clerk userId embedded in a validated JWT's
 * `sub` claim; falls back to `MATRIX_USER_ID` / `MATRIX_HANDLE` so the
 * container-side home-mirror and legacy bearer-token (dev) mode stay aligned,
 * then `"default"` as a last resort.
 *
 * MUST be used by every sync code path (manifest, presign, commit,
 * resolve-conflict, share, WS `sync:subscribe`) so they all key off the
 * same identity. Do not read `process.env.MATRIX_HANDLE` directly from
 * sync handlers.
 */
let warnedDefaultUserIdOnce = false;

function allowDefaultSyncUserIdFallback(): boolean {
  return !process.env.MATRIX_AUTH_TOKEN && process.env.NODE_ENV !== "production";
}

export function getUserIdFromContext(c: Context): string {
  const claims = c.get(JWT_CLAIMS_CONTEXT_KEY) as SyncJwtClaims | undefined;
  if (claims && typeof claims.sub === "string" && claims.sub.length > 0) {
    return claims.sub;
  }
  const matrixUserId = process.env.MATRIX_USER_ID;
  if (matrixUserId && matrixUserId.length > 0) {
    return matrixUserId;
  }
  const handle = process.env.MATRIX_HANDLE;
  if (handle && handle.length > 0) {
    return handle;
  }
  if (!allowDefaultSyncUserIdFallback()) {
    if (!warnedDefaultUserIdOnce) {
      warnedDefaultUserIdOnce = true;
      console.error(
        "[auth] No JWT claims and no MATRIX_HANDLE env var — refusing to fall back to userId='default' while sync auth is enabled.",
      );
    }
    throw new MissingSyncUserIdentityError();
  }
  if (!warnedDefaultUserIdOnce) {
    warnedDefaultUserIdOnce = true;
    console.warn(
      "[auth] No JWT claims and no MATRIX_HANDLE env var — falling back to userId='default' in open local-dev mode only.",
    );
  }
  return "default";
}

const PUBLIC_PATHS = ["/health", "/api/integrations/available"];
const PUBLIC_PREFIXES = [
  "/files/system/icons/",
];
// Paths that authenticate by HMAC signature rather than bearer token.
// They bypass bearer auth but MUST still pass through a rate limiter --
// HMAC verification is not cheap enough to absorb a flood, and invalid
// signatures should throttle the source IP just like invalid bearer
// tokens do. Integrations webhook and voice webhooks live here.
const HMAC_WEBHOOK_PREFIXES = [
  "/api/integrations/webhook/",
];
const WS_QUERY_TOKEN_PATHS = ["/ws/voice", "/ws/terminal", "/ws/onboarding", "/ws/vocal"];

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
    if (!token) return next();

    // Read JWT config + handle per-call so env-var changes during tests
    // are picked up without recreating the middleware.
    const jwtKey = await readJwtKeyConfig();
    const expectedHandle = process.env.MATRIX_HANDLE;

    const normalizedPath = c.req.path;
    if (PUBLIC_PATHS.some((p) => normalizedPath === p) ||
        PUBLIC_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
      return next();
    }

    // HMAC-authenticated paths (Pipedream integrations webhook): bypass
    // bearer auth but still run through a dedicated webhook rate limiter,
    // so HMAC verification can't become a free DoS target. The route
    // handler validates the signature and returns 401 on mismatch; the
    // rate limiter here protects the verification work itself.
    if (HMAC_WEBHOOK_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
      const ip = getClientIp(c);
      if (!webhookRateLimiter.check(ip)) {
        return c.json({ error: "Too many requests" }, 429);
      }
      return next();
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
        return c.json({ error: "Too many requests" }, 429);
      }
      return next();
    }

    const authHeader = c.req.header("Authorization");
    const isWsUpgrade = WS_QUERY_TOKEN_PATHS.some((p) => normalizedPath === p);

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
        // resolve the authenticated Clerk userId via getUserIdFromContext.
        c.set(JWT_CLAIMS_CONTEXT_KEY, claims);
        return next();
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
          return c.json({ error: "Too many requests" }, 429);
        }
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    const legacyHeaderOk =
      token && authHeader && timingSafeCompare(authHeader, `Bearer ${token}`);
    const legacyQueryOk =
      token && isWsUpgrade && queryToken && timingSafeCompare(queryToken, token);

    if (legacyHeaderOk || legacyQueryOk) {
      return next();
    }

    // Only rate-limit failed auth attempts
    const ip = getClientIp(c);
    if (!rateLimiter.check(ip)) {
      return c.json({ error: "Too many requests" }, 429);
    }

    return c.json({ error: "Unauthorized" }, 401);
  };
}
