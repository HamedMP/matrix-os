import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { createRateLimiter } from "./security/rate-limiter.js";

const PUBLIC_PATHS = ["/health"];
const PUBLIC_PREFIXES = ["/voice/webhook"];

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
    if (PUBLIC_PREFIXES.some((p) => c.req.path.startsWith(p))) {
      return next();
    }

    const ip = getClientIp(c);
    if (!rateLimiter.check(ip)) {
      return c.json({ error: "Too many requests" }, 429);
    }

    const authHeader = c.req.header("Authorization");
    let queryToken: string | null = null;
    try {
      queryToken = new URL(c.req.url).searchParams.get("token");
    } catch {
      // URL parsing may fail in some contexts
    }
    const authenticated =
      (authHeader && token && timingSafeCompare(authHeader, `Bearer ${token}`)) ||
      (queryToken && token && timingSafeCompare(queryToken, token));

    if (!authenticated) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  };
}
