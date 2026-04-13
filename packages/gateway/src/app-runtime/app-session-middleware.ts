import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { verifyAppSession, type AppSessionPayloadType } from "./app-session.js";
import { SAFE_SLUG } from "./manifest-schema.js";

// Load interstitial HTML once at module init -- byte-identical across all slugs
const SESSION_INTERSTITIAL_HTML = readFileSync(
  join(import.meta.dirname, "session-interstitial.html"),
  "utf8",
);

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'",
};

function sessionExpiredResponse(
  slug: string,
  accept: string,
  correlationId: string,
): Response {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "WWW-Authenticate": "MatrixAppSession",
    "Matrix-Session-Refresh": `/api/apps/${slug}/session`,
  };

  const wantsHtml = accept.includes("text/html");
  if (wantsHtml) {
    return new Response(SESSION_INTERSTITIAL_HTML, {
      status: 401,
      headers: {
        ...headers,
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response(
    JSON.stringify({ error: "session_expired", correlationId }),
    {
      status: 401,
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
    },
  );
}

export function appSessionMiddleware(
  deriveKey: (slug: string) => Buffer,
): MiddlewareHandler {
  return async (c, next) => {
    const slug = c.req.param("slug");
    if (!slug || !SAFE_SLUG.test(slug)) {
      return c.json({ error: "invalid slug" }, 400);
    }

    const correlationId = crypto.randomUUID();

    // Parse the per-slug cookie
    const cookieName = `matrix_app_session__${slug}`;
    const cookieHeader = c.req.header("cookie") ?? "";
    const cookies = parseCookies(cookieHeader);
    const token = cookies[cookieName];

    if (!token) {
      const accept = c.req.header("accept") ?? "";
      return sessionExpiredResponse(slug, accept, correlationId);
    }

    const key = deriveKey(slug);
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = verifyAppSession(key, token, nowSec);

    if (!payload) {
      const accept = c.req.header("accept") ?? "";
      return sessionExpiredResponse(slug, accept, correlationId);
    }

    // Verify slug matches the cookie payload
    if (payload.slug !== slug) {
      const accept = c.req.header("accept") ?? "";
      return sessionExpiredResponse(slug, accept, correlationId);
    }

    // Inject verified session into context
    c.set("appSession" as never, payload as never);

    await next();
  };
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}
