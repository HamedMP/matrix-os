import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { getOptionalRequestPrincipal, hasVerifiedRuntimeBearer } from "../request-principal.js";

const Setup = z.strictObject({ status: z.enum(["pending", "installing", "ready", "failed", "exhausted", "disabled"]), retryAvailable: z.boolean() });
export type BrowserSetupStatus = z.infer<typeof Setup>;
export interface BrowserSetupClient { status(): Promise<unknown>; retry(): Promise<unknown> }
const execute = promisify(execFile);
/** No request values can become privileged command arguments or environment. */
export function createBrowserSetupClient(run: (file: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }> = execute): BrowserSetupClient {
  const call = async (action: "--status" | "--retry") => {
    const { stdout } = await run("/usr/bin/sudo", ["-n", "/usr/bin/python3", "-I", "/usr/local/libexec/matrix-browser-runtime.py", action], {
      timeout: 5000, maxBuffer: 4096, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
    });
    return Setup.parse(JSON.parse(stdout));
  };
  return { status: () => call("--status"), retry: () => call("--retry") };
}
export interface BrowserSetupOptions { ownerId: string; client: BrowserSetupClient; isAllowedOrigin(origin: string): boolean }
export function registerBrowserSetupRoutes(app: Hono, options: BrowserSetupOptions) {
  const authorize = (c: Context) => {
    if (!hasVerifiedRuntimeBearer(c)) return c.json({ error: "Unauthorized" }, 401);
    const principal = getOptionalRequestPrincipal(c, { configuredUserId: options.ownerId, isTrustedSingleUserGateway: true });
    return principal?.userId === options.ownerId ? null : c.json({ error: "Forbidden" }, 403);
  };
  const result = async (c: Context, retry: boolean) => {
    try {
      const status = Setup.parse(await (retry ? options.client.retry() : options.client.status()));
      return c.json(status, retry && status.status === "installing" ? 202 : 200, { "Cache-Control": "no-store" });
    } catch (error) {
      console.warn("[browser-setup] Native setup unavailable", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "Browser setup is unavailable. Please try again later." }, 503, { "Cache-Control": "no-store" });
    }
  };
  app.get("/api/browser/setup", async c => authorize(c) ?? result(c, false));
  app.post("/api/browser/setup/retry", bodyLimit({ maxSize: 4096 }), async c => {
    const denied = authorize(c); if (denied) return denied;
    const origin = c.req.header("origin");
    if (!origin || !options.isAllowedOrigin(origin)) return c.json({ error: "Forbidden" }, 403);
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      console.warn("[browser-setup] Invalid retry body", error instanceof SyntaxError ? "invalid_json" : "decode_failed");
      return c.json({ error: "Invalid request" }, 400);
    }
    if (!z.strictObject({}).safeParse(raw).success) return c.json({ error: "Invalid request" }, 400);
    return result(c, true);
  });
  app.all("/api/browser/setup", bodyLimit({ maxSize: 4096 }), c => authorize(c) ?? c.json({ error: "Method not allowed" }, 405));
  app.all("/api/browser/setup/retry", bodyLimit({ maxSize: 4096 }), c => authorize(c) ?? c.json({ error: "Method not allowed" }, 405));
}

/** Setup authority exists before the optional native feature flag is enabled. */
export function resolveBrowserSetupOwner(env: NodeJS.ProcessEnv): string | undefined {
  const owner = env.MATRIX_CLERK_USER_ID;
  if (env.MATRIX_RUNTIME_SLOT !== "primary" || !/^[a-z][a-z0-9-]{0,62}$/.test(env.MATRIX_HANDLE ?? "")
    || /^(?:pv-|pr-)/.test(env.MATRIX_HANDLE ?? "")
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(env.MATRIX_MACHINE_ID ?? "")
    || !/^user_[A-Za-z0-9]{1,128}$/.test(owner ?? "")
    || (env.MATRIX_USER_ID !== undefined && env.MATRIX_USER_ID !== owner)) return undefined;
  return owner;
}
