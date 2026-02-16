import type { MiddlewareHandler } from "hono";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-XSS-Protection": "1; mode=block",
};

export function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const isAppContent = c.req.path.startsWith("/files/");

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (isAppContent && name === "X-Frame-Options") continue;
      c.header(name, value);
    }

    await next();
  };
}
