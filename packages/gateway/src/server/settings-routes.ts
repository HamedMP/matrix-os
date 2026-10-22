/** Register the owner's settings, Get started (spec 635) and OS-view state routes. */
import type { Context, Hono } from "hono";
import { createGetStartedMatrixBot } from "../get-started/matrix-bot.js";
import { createOsViewStateRoutes } from "../os-view-state/routes.js";
import { createGetStartedRoutes } from "../routes/get-started.js";

export interface SettingsRouteOptions {
  app: Hono;
  homePath: string;
  settingsRoutes: Hono;
  /** Off unless the deployment opts in (MATRIX_GET_STARTED_ENABLED). */
  getStartedEnabled: boolean;
  getOwnerId(c: Context): string | null;
  botServices: Parameters<typeof createGetStartedMatrixBot>[0] | null | undefined;
  /** Null when the owner database is not configured. */
  osViewState: Parameters<typeof createOsViewStateRoutes>[0] | null;
}

export function registerSettingsRoutes({ app, homePath, settingsRoutes, getStartedEnabled, getOwnerId, botServices, osViewState }: SettingsRouteOptions): void {
  // Mounted before /api/settings so the general settings routes never shadow it.
  app.route("/api/settings/get-started", createGetStartedRoutes({
    homePath,
    enabled: getStartedEnabled,
    getOwnerId,
    ...(botServices ? { ensureMatrixBot: createGetStartedMatrixBot(botServices) } : {}),
  }));
  app.route("/api/settings", settingsRoutes);
  if (osViewState) {
    app.route("/api/os-view-state", createOsViewStateRoutes(osViewState));
  } else {
    app.all("/api/os-view-state", (c) => c.json({ error: "OS-view state is not configured" }, 503));
  }
}
