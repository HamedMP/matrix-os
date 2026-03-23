import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { createRateLimiter } from "./security/rate-limiter.js";

const PUBLIC_PATHS = ["/health"];
const PUBLIC_PREFIXES = ["/voice/webhook"];
const WS_QUERY_TOKEN_PATHS = ["/ws/voice"];

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const rateLimiter = createRateLimiter({
  maxAttempts: 10,
  windowMs: 60_000,
  lockoutMs: 300_000,
});

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "127.0.0.1";
}

export function authMiddleware(token: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!token) return next();

    if (PUBLIC_PATHS.some((p) => c.req.path === p)) {
      return next();
    }

    const isWebhook = PUBLIC_PREFIXES.some((p) => c.req.path.startsWith(p));
    if (isWebhook) {
      // Apply rate limiting to webhooks even though they skip auth
      const ip = getClientIp(c);
      if (!rateLimiter.check(ip)) {
        return c.json({ error: "Too many requests" }, 429);
      }
      return next();
    }

    const ip = getClientIp(c);
    if (!rateLimiter.check(ip)) {
      return c.json({ error: "Too many requests" }, 429);
    }

    const authHeader = c.req.header("Authorization");
    const isWsUpgrade = WS_QUERY_TOKEN_PATHS.some((p) => c.req.path === p);

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

    if (!authenticated) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  };
}
