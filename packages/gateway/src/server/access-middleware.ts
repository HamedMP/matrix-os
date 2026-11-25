import type { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "../auth.js";
import { registerRoutineDirectResourceFence } from "../chat/routine-direct-visibility.js";
import { securityHeadersMiddleware } from "../security/headers.js";

interface GatewayAccessOptions {
  resolveAllowedOrigin(origin: string): string | undefined;
  /**
   * Local development only. Sandboxed srcdoc apps send a null origin for file
   * assets, and SameSite=Strict app-session cookies are unavailable over HTTP.
   * The caller uses the same flag for the local app-session gate.
   */
  devAppAuthBypass: boolean;
  authToken: string | undefined;
  auth: Parameters<typeof authMiddleware>[1];
}

export function registerGatewayAccessMiddleware(app: Hono, options: GatewayAccessOptions): void {
  app.use("*", cors({
    origin: (origin) => {
      if (options.devAppAuthBypass && origin === "null") return "null";
      return options.resolveAllowedOrigin(origin);
    },
  }));
  app.use("*", securityHeadersMiddleware());
  app.use("*", authMiddleware(options.authToken, options.auth));
  registerRoutineDirectResourceFence(app);
}
