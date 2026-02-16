import type { MiddlewareHandler } from "hono";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-XSS-Protection": "1; mode=block",
};

export function securityHeadersMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.header(name, value);
    }
    await next();
  };
}
