import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { checkForSystemUpdate, listSystemReleases, readSystemUpdateFailure, resolveSystemUpdateChannel, resolveInternalUpgradeStartTarget, resolveInternalUpgradeInstallTarget, startSystemUpdate, startSystemUpdateRepair } from './system-update.js';
import type { getSystemInfo } from './system-info.js';
import type { createManagedUpdatePolicy } from './managed-update-policy.js';

export function createSystemUpdateRoutes(deps: {
  getInfo: () => ReturnType<typeof getSystemInfo>;
  policy: ReturnType<typeof createManagedUpdatePolicy>;
  isBusy: () => boolean;
  capture: (event: 'matrix_system_update_requested' | 'matrix_system_update_repair_requested', properties: Record<string, string>) => Promise<unknown>;
}): Hono {
  const app = new Hono();
  const upgradeBodyLimit = bodyLimit({ maxSize: 4096 });
  app.get("/update", async (c) => {
    const info = deps.getInfo();
    const requested = deps.policy.managed && !await deps.policy.canSelect(c.req.header("authorization"), c.req.header("x-matrix-customer-proxy")) ? "stable" : c.req.query("channel");
    const channel = resolveSystemUpdateChannel(requested, {
      envChannel: process.env.MATRIX_UPDATE_CHANNEL,
      installedChannel: info.release?.channel,
    });
    if (!channel) return c.json({ error: "Invalid update channel" }, 400);
    const result = await checkForSystemUpdate({
      installed: info.release ?? {
        version: info.version,
        gitCommit: info.build.sha,
        gitRef: info.build.ref,
        buildTime: info.build.date,
      },
      platformUrl: process.env.MATRIX_UPDATE_MANIFEST_BASE_URL ?? process.env.PLATFORM_INTERNAL_URL,
      channel,
    });
    const installError = await readSystemUpdateFailure();
    return c.json({ ...result, installError });
  });

  app.get("/releases", async (c) => {
    const info = deps.getInfo();
    const requested = deps.policy.managed && !await deps.policy.canSelect(c.req.header("authorization"), c.req.header("x-matrix-customer-proxy")) ? "stable" : c.req.query("channel");
    const channel = resolveSystemUpdateChannel(requested, {
      envChannel: process.env.MATRIX_UPDATE_CHANNEL,
      installedChannel: info.release?.channel,
    });
    if (!channel) return c.json({ error: "Invalid update channel" }, 400);
    const result = await listSystemReleases({
      platformUrl: process.env.MATRIX_UPDATE_MANIFEST_BASE_URL ?? process.env.PLATFORM_INTERNAL_URL,
      channel,
    });
    return c.json(result);
  });

  async function startUpdateFromRequest(c: Context) {
    if (!await deps.policy.canSelect(c.req.header("authorization"), c.req.header("x-matrix-customer-proxy"))) return c.json({ error: "Updates are managed automatically" }, 403);
    if (deps.policy.managed && deps.isBusy()) return c.json({ error: "Runtime is busy", code: "runtime_busy" }, 409);
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      // Preserve the middleware's oversized-stream signal; never fall through
      // into a default-channel install when reading the request failed.
      if (err instanceof HTTPException || (err instanceof Error && err.name === 'BodyLimitError')) throw err;
      if (!(err instanceof SyntaxError)) {
        console.warn("[system-update] Failed to parse update request:", err instanceof Error ? err.name : typeof err);
      }
      return c.json({ error: "Invalid request" }, 400);
    }
    const info = deps.getInfo();
    const parsedTarget = resolveInternalUpgradeStartTarget(body, {
      envChannel: process.env.MATRIX_UPDATE_CHANNEL,
      installedChannel: info.release?.channel,
    });
    if (!parsedTarget.ok) return c.json({ error: "Invalid request" }, 400);

    let installTarget: Extract<typeof parsedTarget.target, { type: "version" }>;
    try {
      installTarget = await resolveInternalUpgradeInstallTarget({
        target: parsedTarget.target,
        platformUrl: process.env.MATRIX_UPDATE_MANIFEST_BASE_URL ?? process.env.PLATFORM_INTERNAL_URL,
      });
    } catch (err: unknown) {
      console.warn("[system-update] Failed to resolve requested update version:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Update is unavailable" }, 503);
    }

    const result = await startSystemUpdate({ target: installTarget });
    if (!result.ok) {
      return c.json({ error: "Update not configured" }, 503);
    }
    const targetProperty: Record<string, string> =
      parsedTarget.target.type === "channel"
        ? { channel: parsedTarget.target.value, version: installTarget.value }
        : { version: parsedTarget.target.value };
    void deps.capture("matrix_system_update_requested", targetProperty).catch((err: unknown) => {
      console.warn("[system-update] Telemetry failed", err instanceof Error ? err.name : typeof err);
    });
    return c.json({ ok: true, status: result.status, ...targetProperty }, 202);
  }

  app.post("/update", upgradeBodyLimit, startUpdateFromRequest);

  app.post("/update/repair", upgradeBodyLimit, async (c) => {
    if (!await deps.policy.canSelect(c.req.header("authorization"), c.req.header("x-matrix-customer-proxy"))) return c.json({ error: "Updates are managed automatically" }, 403);
    const result = await startSystemUpdateRepair();
    if (!result.ok) {
      return c.json({ error: "Update repair not configured" }, 503);
    }
    void deps.capture("matrix_system_update_repair_requested", {}).catch((err: unknown) => {
      console.warn("[system-update] Telemetry failed", err instanceof Error ? err.name : typeof err);
    });
    return c.json({ ok: true, status: result.status }, 202);
  });

  app.post("/upgrade", upgradeBodyLimit, async (c) => {
    return startUpdateFromRequest(c);
  });

  return app;
}
