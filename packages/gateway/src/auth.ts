import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { createRateLimiter } from "./security/rate-limiter.js";

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
const WS_QUERY_TOKEN_PATHS = ["/ws/voice", "/ws/terminal"];
// Spec 062: /ws/groups/{slug}/{app} is a dynamic path that also needs
// query-token auth because browsers cannot set Authorization headers on
// WebSocket upgrades. Prefix-match rather than list each concrete path.
const WS_QUERY_TOKEN_PREFIXES = ["/ws/groups/"];

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
  return c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "127.0.0.1";
}

export function authMiddleware(
  token: string | undefined,
  options?: { webhookProviders?: Set<string> },
): MiddlewareHandler {
  const webhookProviders = options?.webhookProviders ?? new Set<string>();

  return async (c, next) => {
    if (!token) return next();

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(c.req.path);
    } catch {
      return c.json({ error: "Bad request" }, 400);
    }
    const normalizedPath = new URL(decodedPath, "http://localhost").pathname;
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
    const webhookMatch = c.req.path.match(/^\/voice\/webhook\/([a-z0-9-]+)$/);
    const isWebhook = webhookMatch && webhookProviders.has(webhookMatch[1]);
    if (isWebhook) {
      const ip = getClientIp(c);
      if (!rateLimiter.check(ip)) {
        return c.json({ error: "Too many requests" }, 429);
      }
      return next();
    }

    const authHeader = c.req.header("Authorization");
    const isWsUpgrade =
      WS_QUERY_TOKEN_PATHS.some((p) => c.req.path === p) ||
      WS_QUERY_TOKEN_PREFIXES.some((p) => c.req.path.startsWith(p));

    // Only accept query param token for WebSocket upgrades (browsers can't set
    // Authorization headers on WS connections). REST endpoints must use headers.
    let queryToken: string | null = null;
    if (isWsUpgrade) {
      try {
        queryToken = new URL(c.req.url).searchParams.get("token");
      } catch {
        // URL parsing may fail in some contexts
      }
    }

    const authenticated =
      (authHeader && timingSafeCompare(authHeader, `Bearer ${token}`)) ||
      (isWsUpgrade && queryToken && timingSafeCompare(queryToken, token));

    if (authenticated) {
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
