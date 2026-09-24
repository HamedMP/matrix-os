/** Register owner system, update, usage, push and client-error routes. */
import { bodyLimit } from "hono/body-limit";
import type { Context, Hono } from "hono";
import { z } from "zod/v4";
import { createUsageTracker } from "@matrix-os/kernel";
import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { createPushAdapter } from "../channels/push.js";
import {
  CLIENT_ERROR_LOG_BODY_LIMIT, ClientErrorReportSchema,
  forwardClientErrorToPostHog, writeClientErrorReport,
} from "../client-error-log.js";
import type { InteractionLogger } from "../logger.js";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal } from "../request-principal.js";
import { timingSafeStringEquals } from "../security/timing-safe.js";
import { getSystemInfo } from "../system-info.js";
import {
  checkForSystemUpdate, listSystemReleases, readSystemUpdateFailure,
  resolveInternalUpgradeInstallTarget, resolveInternalUpgradeStartTarget,
  resolveSystemUpdateChannel, startSystemUpdate, startSystemUpdateRepair,
} from "../system-update.js";
import type { GatewayConfig } from "./types.js";

const PushRegisterBodySchema = z.object({
  token: z.string().trim().min(1).max(512),
  platform: z.string().trim().min(1).max(32),
}).strict();
const PushUnregisterBodySchema = z.object({
  token: z.string().trim().min(1).max(512),
}).strict();

export interface SystemOperatorRouteOptions {
  app: Hono;
  homePath: string;
  model: GatewayConfig["model"];
  runningVersion: string;
  interactionLogger: InteractionLogger;
  pushAdapter: ReturnType<typeof createPushAdapter>;
  posthogErrorTracker: ReturnType<typeof installPostHogHonoErrorTracking>;
  ownerTelemetryDistinctId: string;
  upgradeBodyLimit: ReturnType<typeof bodyLimit>;
  logBestEffortFailure(context: string, error: unknown): void;
}

export function registerSystemOperatorRoutes(options: SystemOperatorRouteOptions): void {
  const { app, homePath, model, runningVersion, interactionLogger, pushAdapter,
    posthogErrorTracker, ownerTelemetryDistinctId, upgradeBodyLimit,
    logBestEffortFailure } = options;
  app.get("/api/system/info", (c) => {
    const info = getSystemInfo(homePath, { model: model, runningVersion });
    const today = new Date().toISOString().slice(0, 10);
    return c.json({ ...info, todayCost: interactionLogger.totalCost(today) });
  });

  app.get("/api/system/update", async (c) => {
    const info = getSystemInfo(homePath, { model: model, runningVersion });
    const channel = resolveSystemUpdateChannel(c.req.query("channel"), {
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

  app.get("/api/system/releases", async (c) => {
    const info = getSystemInfo(homePath, { model: model, runningVersion });
    const channel = resolveSystemUpdateChannel(c.req.query("channel"), {
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

  app.post("/system/backup", bodyLimit({ maxSize: 1024 }), (c) => {
    const token = process.env.MATRIX_SYSTEM_BACKUP_TOKEN;
    if (!token) {
      return c.json({ error: "Backup trigger not configured" }, 503);
    }
    const authHeader = c.req.header("authorization");
    const presented = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!timingSafeStringEquals(presented, token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({ error: "Backup trigger not implemented" }, 501);
  });

  async function startUpdateFromRequest(c: Context) {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[system-update] Failed to parse update request:", err);
      }
    }
    const info = getSystemInfo(homePath, { model: model, runningVersion });
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
    const targetProperty =
      parsedTarget.target.type === "channel"
        ? { channel: parsedTarget.target.value, version: installTarget.value }
        : { version: parsedTarget.target.value };
    void posthogErrorTracker.captureEvent("matrix_system_update_requested", {
      distinctId: ownerTelemetryDistinctId,
      properties: {
        ...targetProperty,
        targetType: parsedTarget.target.type,
        handle: process.env.MATRIX_HANDLE,
      },
    }).catch((err: unknown) => {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[posthog] Failed to queue system update event: ${kind}`);
    });
    return c.json({ ok: true, status: result.status, ...targetProperty }, 202);
  }

  app.post("/api/system/update", upgradeBodyLimit, startUpdateFromRequest);

  app.post("/api/system/update/repair", upgradeBodyLimit, async (c) => {
    const result = await startSystemUpdateRepair();
    if (!result.ok) {
      return c.json({ error: "Update repair not configured" }, 503);
    }
    void posthogErrorTracker.captureEvent("matrix_system_update_repair_requested", {
      distinctId: ownerTelemetryDistinctId,
      properties: {
        handle: process.env.MATRIX_HANDLE,
      },
    }).catch((err: unknown) => {
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`[posthog] Failed to queue system update repair event: ${kind}`);
    });
    return c.json({ ok: true, status: result.status }, 202);
  });

  app.post("/api/system/upgrade", upgradeBodyLimit, async (c) => {
    return startUpdateFromRequest(c);
  });

  const usageTracker = createUsageTracker(homePath);

  app.get("/api/usage", (c) => {
    try {
      const period = (c.req.query("period") ?? "daily") as string;
      const date = c.req.query("date") as string | undefined;
      const month = c.req.query("month") as string | undefined;

      if (period === "monthly") {
        return c.json(usageTracker.getMonthly(month));
      }
      return c.json(usageTracker.getDaily(date));
    } catch (err: unknown) {
      logBestEffortFailure("Failed to read usage stats", err);
      return c.json({ total: 0, byAction: {} });
    }
  });

  app.post("/api/push/register", bodyLimit({ maxSize: 4096 }), async (c) => {
    let principal;
    try {
      principal = requireRequestPrincipal(c);
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err, "Push registration failed");
        if (mapped.log) console.error("[push] Request principal misconfigured:", err.name);
        return c.json(mapped.body, mapped.status);
      }
      throw err;
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        logBestEffortFailure("Failed to parse push registration", err);
      }
      return c.json({ error: "Invalid push registration" }, 400);
    }

    const parsed = PushRegisterBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid push registration" }, 400);
    }

    pushAdapter.registerToken(parsed.data.token, parsed.data.platform, principal.userId);
    return c.json({ ok: true });
  });

  app.delete("/api/push/register", bodyLimit({ maxSize: 4096 }), async (c) => {
    let principal;
    try {
      principal = requireRequestPrincipal(c);
    } catch (err: unknown) {
      if (isRequestPrincipalError(err)) {
        const mapped = mapRequestPrincipalError(err, "Push registration failed");
        if (mapped.log) console.error("[push] Request principal misconfigured:", err.name);
        return c.json(mapped.body, mapped.status);
      }
      throw err;
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        logBestEffortFailure("Failed to parse push registration removal", err);
      }
      return c.json({ error: "Invalid push registration" }, 400);
    }

    const parsed = PushUnregisterBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid push registration" }, 400);
    }

    pushAdapter.removeToken(parsed.data.token, principal.userId);
    return c.json({ ok: true });
  });

  app.post("/api/client-errors", bodyLimit({ maxSize: CLIENT_ERROR_LOG_BODY_LIMIT }), async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch (err: unknown) {
      if (!(err instanceof SyntaxError)) {
        console.warn("[client-error-log] Failed to parse client error report:", err);
      }
      return c.json({ error: "Invalid client error report" }, 400);
    }

    const parsed = ClientErrorReportSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid client error report" }, 400);
    }

    try {
      await writeClientErrorReport(homePath, parsed.data);
      // Fire-and-forget PostHog forwarding so client exceptions are visible
      // beyond the owner-local JSONL. Must never affect the 2xx response.
      forwardClientErrorToPostHog(posthogErrorTracker, ownerTelemetryDistinctId, parsed.data);
      return c.json({ ok: true });
    } catch (err: unknown) {
      console.warn("[client-error-log] Failed to persist client error report:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Unable to record client error" }, 500);
    }
  });

}
