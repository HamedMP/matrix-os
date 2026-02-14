import type { MiddlewareHandler } from "hono";

const PUBLIC_PATHS = ["/health"];

export function authMiddleware(token: string | undefined): MiddlewareHandler {
  return async (c, next) => {
    if (!token) return next();

    if (PUBLIC_PATHS.some((p) => c.req.path === p)) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return next();
  };
}
