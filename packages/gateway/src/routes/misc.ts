/**
 * Misc operator routes: metrics, plugins, games, health, internal upgrade
 * (extracted from server.ts, Phase 1-A1.4).
 *
 * Pure move: handler bodies are byte-identical to the inline versions.
 * The metrics *recording* middleware stays in server.ts because it must wrap
 * every route; only the `/metrics` scrape endpoint moves here.
 */

import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  metricsRegistry,
} from "../domains/observability/metrics.js";
import { getLeaderboard } from "../domains/social/leaderboard.js";
import { writeInternalUpgradeTrigger } from "../domains/observability/system-update.js";
import { timingSafeStringEquals } from "../security/timing-safe.js";
import type { PluginRegistry, LoadedPlugin } from "../plugins/index.js";
import type { CronService } from "../cron/service.js";
import type { ChannelManager } from "../channels/manager.js";

const UPGRADE_BODY_LIMIT = 4096; // 4 KiB

export interface MiscRouteDeps {
  homePath: string;
  runningVersion: string;
  cronService: CronService;
  channelManager: ChannelManager;
  pluginRegistry: PluginRegistry;
  /** Request-time reader: the plugin list is populated asynchronously during
   *  startup, so a closure preserves the original read-timing. */
  getLoadedPlugins: () => LoadedPlugin[];
  logUnexpectedJsonParseFailure: (context: string, err: unknown) => void;
}

export function createMiscRoutes(
  deps: MiscRouteDeps,
  registry: typeof metricsRegistry = metricsRegistry,
): Hono {
  const app = new Hono();
  const upgradeBodyLimit = bodyLimit({ maxSize: UPGRADE_BODY_LIMIT });

  app.get("/metrics", async (c) => {
    const output = await registry.metrics();
    return c.text(output, 200, {
      "Content-Type": registry.contentType,
    });
  });

  // T946: Plugin list endpoint
  app.get("/api/plugins", (c) => {
    return c.json(
      deps.getLoadedPlugins().map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name ?? p.manifest.id,
        version: p.manifest.version ?? "0.0.0",
        description: p.manifest.description,
        origin: p.origin,
        status: p.status,
        error: p.error,
        contributions: deps.pluginRegistry.getPluginContributions(p.manifest.id),
      })),
    );
  });

  // T2063: Leaderboard API routes
  app.get("/api/games/leaderboard", (c) => {
    return c.json(getLeaderboard(deps.homePath));
  });

  app.get("/api/games/leaderboard/:game", (c) => {
    const game = c.req.param("game");
    return c.json(getLeaderboard(deps.homePath, game));
  });

  app.get("/health", (c) => c.json({
    status: "ok",
    runningVersion: deps.runningVersion,
    cronJobs: deps.cronService.listJobs().length,
    channels: deps.channelManager.status(),
    plugins: deps.getLoadedPlugins().length,
    workspace: {
      status: "ok",
    },
    sessions: {
      status: "ok",
    },
    reviews: {
      status: "ok",
    },
    sandbox: {
      status: typeof process.getuid === "function" && process.getuid() === 0 ? "degraded" : "ok",
    },
    memory: {
      rssBytes: process.memoryUsage.rss(),
      pendingPersistBytes: 0,
    },
    browserIde: {
      status: process.env.MATRIX_CODE_SERVER_PORT ? "configured" : "disabled",
    },
  }));

  app.post("/api/internal/upgrade", upgradeBodyLimit, async (c) => {
    const upgradeToken = process.env.UPGRADE_TOKEN;
    if (!upgradeToken) return c.json({ error: "UPGRADE_TOKEN not configured" }, 503);
    const auth = c.req.header("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!timingSafeStringEquals(token, upgradeToken)) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown = {};
    const raw = await c.req.text();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch (err: unknown) {
        deps.logUnexpectedJsonParseFailure("Failed to parse internal upgrade payload", err);
        return c.json({ error: "Invalid JSON" }, 400);
      }
    }

    const result = await writeInternalUpgradeTrigger({ body });
    if (!result.ok) return c.json({ error: result.error }, 400);

    return c.json({ status: "upgrading", target: result.target }, 202);
  });

  return app;
}
