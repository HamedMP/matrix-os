/**
 * Identity / logs / system / push / client-error routes (extracted from
 * server.ts, Phase 1-A1.3).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 * Owns the owner-local introspection surface: identity files, log queries,
 * update machinery, push registration, and client error reports.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { loadHandle, createUsageTracker } from "@matrix-os/kernel";
import { getSystemInfo } from "../domains/observability/system-info.js";
import {
  checkForSystemUpdate,
  listSystemReleases,
  readSystemUpdateFailure,
  resolveInternalUpgradeInstallTarget,
  resolveInternalUpgradeStartTarget,
  resolveSystemUpdateChannel,
  startSystemUpdate,
  startSystemUpdateRepair,
} from "../domains/observability/system-update.js";
import { type InteractionLogger } from "../_shared/logger.js";
import {
  CLIENT_ERROR_LOG_BODY_LIMIT,
  ClientErrorReportSchema,
  forwardClientErrorToPostHog,
  writeClientErrorReport,
} from "../domains/observability/client-error-log.js";
import { timingSafeStringEquals } from "../security/timing-safe.js";
import { type createPushAdapter } from "../channels/push.js";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
  requireRequestPrincipal,
} from "../domains/identity/request-principal.js";

const UPGRADE_BODY_LIMIT = 4096; // 4 KiB
const PUSH_REGISTRATION_BODY_LIMIT = 4096; // 4 KiB

const PushRegisterBodySchema = z.object({
  token: z.string().trim().min(1).max(512),
  platform: z.string().trim().min(1).max(32),
}).strict();

const PushUnregisterBodySchema = z.object({
  token: z.string().trim().min(1).max(512),
}).strict();

export interface SystemRouteDeps {
  homePath: string;
  /** Request-time reader: preserves the original read-timing. */
  getConfigModel: () => string | undefined;
  runningVersion: string;
  interactionLogger: InteractionLogger;
  logBestEffortFailure: (context: string, err: unknown) => void;
  pushAdapter: ReturnType<typeof createPushAdapter>;
  posthogErrorTracker: ReturnType<typeof installPostHogHonoErrorTracking>;
  ownerTelemetryDistinctId: string;
}

export function createSystemRoutes(deps: SystemRouteDeps): Hono {
  const app = new Hono();
  const upgradeBodyLimit = bodyLimit({ maxSize: UPGRADE_BODY_LIMIT });
  const pushRegistrationBodyLimit = bodyLimit({ maxSize: PUSH_REGISTRATION_BODY_LIMIT });
  const clientErrorBodyLimit = bodyLimit({ maxSize: CLIENT_ERROR_LOG_BODY_LIMIT });
  const usageTracker = createUsageTracker(deps.homePath);

  app.get("/api/identity", (c) => {
    return c.json(loadHandle(deps.homePath));
  });

  app.get("/api/profile", (c) => {
    const profilePath = join(deps.homePath, "system", "profile.md");
    if (!existsSync(profilePath)) return c.text("No profile", 404);
    return c.text(readFileSync(profilePath, "utf-8"));
  });

  app.get("/api/ai-profile", (c) => {
    const aiProfilePath = join(deps.homePath, "system", "ai-profile.md");
    if (!existsSync(aiProfilePath)) return c.text("No AI profile", 404);
    return c.text(readFileSync(aiProfilePath, "utf-8"));
  });

  app.get("/api/logs", (c) => {
    const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
    const source = c.req.query("source");
    const entries = deps.interactionLogger.query({ date, source });
    return c.json({ entries, totalCost: deps.interactionLogger.totalCost(date) });
  });

  app.get("/api/security/audit", async (c) => {
    const { runSecurityAudit } = await import("@matrix-os/kernel/security/audit");
    const report = await runSecurityAudit(deps.homePath);
    return c.json(report);
  });

  app.get("/api/system/info", (c) => {
    const info = getSystemInfo(deps.homePath, { model: deps.getConfigModel(), runningVersion: deps.runningVersion });
    const today = new Date().toISOString().slice(0, 10);
    return c.json({ ...info, todayCost: deps.interactionLogger.totalCost(today) });
  });

  app.get("/api/system/update", async (c) => {
    const info = getSystemInfo(deps.homePath, { model: deps.getConfigModel(), runningVersion: deps.runningVersion });
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
    const info = getSystemInfo(deps.homePath, { model: deps.getConfigModel(), runningVersion: deps.runningVersion });
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
    const info = getSystemInfo(deps.homePath, { model: deps.getConfigModel(), runningVersion: deps.runningVersion });
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
    void deps.posthogErrorTracker.captureEvent("matrix_system_update_requested", {
      distinctId: deps.ownerTelemetryDistinctId,
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
    void deps.posthogErrorTracker.captureEvent("matrix_system_update_repair_requested", {
      distinctId: deps.ownerTelemetryDistinctId,
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
      deps.logBestEffortFailure("Failed to read usage stats", err);
      return c.json({ total: 0, byAction: {} });
    }
  });

  app.post("/api/push/register", pushRegistrationBodyLimit, async (c) => {
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
        deps.logBestEffortFailure("Failed to parse push registration", err);
      }
      return c.json({ error: "Invalid push registration" }, 400);
    }

    const parsed = PushRegisterBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid push registration" }, 400);
    }

    deps.pushAdapter.registerToken(parsed.data.token, parsed.data.platform, principal.userId);
    return c.json({ ok: true });
  });

  app.delete("/api/push/register", pushRegistrationBodyLimit, async (c) => {
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
        deps.logBestEffortFailure("Failed to parse push registration removal", err);
      }
      return c.json({ error: "Invalid push registration" }, 400);
    }

    const parsed = PushUnregisterBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid push registration" }, 400);
    }

    deps.pushAdapter.removeToken(parsed.data.token, principal.userId);
    return c.json({ ok: true });
  });

  app.post("/api/client-errors", clientErrorBodyLimit, async (c) => {
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
      await writeClientErrorReport(deps.homePath, parsed.data);
      // Fire-and-forget PostHog forwarding so client exceptions are visible
      // beyond the owner-local JSONL. Must never affect the 2xx response.
      forwardClientErrorToPostHog(deps.posthogErrorTracker, deps.ownerTelemetryDistinctId, parsed.data);
      return c.json({ ok: true });
    } catch (err: unknown) {
      console.warn("[client-error-log] Failed to persist client error report:", err instanceof Error ? err.message : String(err));
      return c.json({ error: "Unable to record client error" }, 500);
    }
  });

  return app;
}
