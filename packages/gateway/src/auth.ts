import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { createRateLimiter } from "./security/rate-limiter.js";

const PUBLIC_PATHS = ["/health"];

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

    const ip = getClientIp(c);
    if (!rateLimiter.check(ip)) {
      return c.json({ error: "Too many requests" }, 429);
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || !timingSafeCompare(authHeader, `Bearer ${token}`)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  };
}
