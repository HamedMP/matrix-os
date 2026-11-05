/** Register the owner's settings, Get started (spec 635) and OS-view state routes. */
import type { Context, Hono } from "hono";
import { createGetStartedBotNameClient } from "../get-started/bot-names-client.js";
import { createGetStartedBotStatus, createGetStartedBots } from "../get-started/bots.js";
import { createOsViewStateRoutes } from "../os-view-state/routes.js";
import { createGetStartedRoutes } from "../routes/get-started.js";
import type { ChatAgentStore } from "../chat/agent-store.js";

export interface SettingsRouteOptions {
  app: Hono;
  homePath: string;
  settingsRoutes: Hono;
  /** MATRIX_GET_STARTED_ENABLED=true. The platform sets it on new computers; the surfaces' PostHog flag decides who sees the wizard. */
  getStartedEnabled: boolean;
  getOwnerId(c: Context): string | null;
  getStartedEnrollment?: {
    ownerId: string | null | undefined;
    runtimeSlot: string | undefined;
    agents: Pick<ChatAgentStore, "list"> | null;
  };
  botServices: Parameters<typeof createGetStartedBots>[0] | null | undefined;
  /** Null when the owner database is not configured. */
  osViewState: Parameters<typeof createOsViewStateRoutes>[0] | null;
}

export function registerSettingsRoutes({ app, homePath, settingsRoutes, getStartedEnabled, getOwnerId, getStartedEnrollment, botServices, osViewState }: SettingsRouteOptions): void {
  // Spec 636: name suggestions come from the platform over this computer's machine bearer.
  const botNames = createGetStartedBotNameClient({
    platformUrl: process.env.PLATFORM_INTERNAL_URL,
    token: process.env.UPGRADE_TOKEN,
    handle: process.env.MATRIX_HANDLE,
  });
  // Mounted before /api/settings so the general settings routes never shadow it.
  app.route("/api/settings/get-started", createGetStartedRoutes({
    homePath,
    enabled: getStartedEnabled,
    getOwnerId,
    ...(getStartedEnrollment ? { canEnroll: async (ownerId: string) => {
      const enrollment = getStartedEnrollment;
      if ((enrollment.runtimeSlot ?? "primary") !== "primary" || ownerId !== enrollment.ownerId) return false;
      if (!enrollment.agents) throw new Error("Get started agent inventory is unavailable");
      return (await enrollment.agents.list({ type: "personal", ownerId })).length === 0;
    } } : {}),
    ...(botServices ? { ensureBot: createGetStartedBots(botServices), botStatus: createGetStartedBotStatus(botServices) } : {}),
    ...(botNames ? { suggestBotNames: botNames.suggest } : {}),
  }));
  app.route("/api/settings", settingsRoutes);
  if (osViewState) {
    app.route("/api/os-view-state", createOsViewStateRoutes(osViewState));
  } else {
    app.all("/api/os-view-state", (c) => c.json({ error: "OS-view state is not configured" }, 503));
  }
}
