/** Register operational health, plugin, leaderboard and upgrade routes. */
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { QueryEngine } from "../app-db-query.js";
import type { ChannelManager } from "../channels/manager.js";
import type { CronService } from "../cron/service.js";
import type { LoadedPlugin, PluginRegistry } from "../plugins/index.js";
import { timingSafeStringEquals } from "../security/timing-safe.js";
import { insertPost } from "../social.js";
import { createActivityService } from "../social-activity.js";
import { writeInternalUpgradeTrigger } from "../system-update.js";

export interface OperationalRouteOptions {
  app: Hono;
  homePath: string;
  runningVersion: string;
  queryEngine: QueryEngine | null;
  pluginRegistry: PluginRegistry;
  getLoadedPlugins(): LoadedPlugin[];
  cronService: CronService;
  channelManager: ChannelManager;
  upgradeBodyLimit: ReturnType<typeof bodyLimit>;
  logUnexpectedJsonParseFailure(context: string, error: unknown): void;
}

export async function registerOperationalRoutes(options: OperationalRouteOptions): Promise<void> {
  const { app, homePath, runningVersion, queryEngine, pluginRegistry,
    getLoadedPlugins, cronService, channelManager, upgradeBodyLimit,
    logUnexpectedJsonParseFailure } = options;
  // T2036: Activity auto-posting
  const activityService = createActivityService({
    homePath,
    createPost: queryEngine ? (post) => insertPost(queryEngine, post) : async () => "",
  });

  // T946: Plugin list endpoint
  app.get("/api/plugins", (c) => {
    return c.json(
      getLoadedPlugins().map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name ?? p.manifest.id,
        version: p.manifest.version ?? "0.0.0",
        description: p.manifest.description,
        origin: p.origin,
        status: p.status,
        error: p.error,
        contributions: pluginRegistry.getPluginContributions(p.manifest.id),
      })),
    );
  });

  // T2063: Leaderboard API routes
  const { getLeaderboard } = await import("../leaderboard.js");

  app.get("/api/games/leaderboard", (c) => {
    return c.json(getLeaderboard(homePath));
  });

  app.get("/api/games/leaderboard/:game", (c) => {
    const game = c.req.param("game");
    return c.json(getLeaderboard(homePath, game));
  });

  app.get("/health", (c) => c.json({
    status: "ok",
    runningVersion,
    cronJobs: cronService.listJobs().length,
    channels: channelManager.status(),
    plugins: getLoadedPlugins().length,
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
        logUnexpectedJsonParseFailure("Failed to parse internal upgrade payload", err);
        return c.json({ error: "Invalid JSON" }, 400);
      }
    }

    const result = await writeInternalUpgradeTrigger({ body });
    if (!result.ok) return c.json({ error: result.error }, 400);

    return c.json({ status: "upgrading", target: result.target }, 202);
  });

}
