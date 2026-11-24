/**
 * Register every terminal socket: Matrix tabs, the terminal event stream,
 * Herdr sessions (spec 2701) and the Desktop link (spec 2716).
 */
import type { Kysely } from "kysely";
import type { HerdrAdapter } from "../herdr/adapter.js";
import { readDesktopLinkConfig, registerDesktopLinkRoutes } from "../desktop-link/routes.js";
import { registerDesktopLinkTerminalSocket } from "../desktop-link/terminal-routes.js";
import type { DesktopPairingDatabase } from "../desktop-pairing/database.js";
import { registerHerdrSessionRoutes } from "../herdr/register.js";
import { registerTerminalEventWebSocket } from "../terminal-agent/events-ws.js";
import type { TerminalAgentServices } from "../terminal-agent/services.js";
import { registerTerminalWebSocketRoutes } from "./terminal-ws-routes.js";

type TerminalTabSocketOptions = Parameters<typeof registerTerminalWebSocketRoutes>[0];

export function registerTerminalSockets(options: Omit<TerminalTabSocketOptions, "terminalInputActivity"> & {
  terminalAgents: TerminalAgentServices;
  herdrSessions: HerdrAdapter | null;
  /** Owner Postgres with 2698's desktop pairing; the desktop link answers 503 without it. */
  ownerDatabase?: Kysely<DesktopPairingDatabase> | null;
  env?: NodeJS.ProcessEnv;
}) {
  const { app, upgradeWebSocket, getPrincipal, terminalRuntimeOwnerIds, terminalLiveOwnership, terminalAgents } = options;
  registerTerminalWebSocketRoutes({ ...options, terminalInputActivity: terminalAgents.inputActivity });
  registerTerminalEventWebSocket({ app, upgradeWebSocket, hub: terminalAgents.events, getPrincipal, terminalOwnerIds: terminalRuntimeOwnerIds });
  const desktopLinks = registerDesktopLinkRoutes({
    app, upgradeWebSocket, ownerDatabase: options.ownerDatabase ?? null, config: readDesktopLinkConfig(options.env ?? process.env),
  });
  const desktopViewers = desktopLinks ? registerDesktopLinkTerminalSocket({
    app, upgradeWebSocket, registry: desktopLinks, getPrincipal, terminalOwnerIds: terminalRuntimeOwnerIds,
    terminalLiveOwnership, terminalInputActivity: terminalAgents.inputActivity,
  }) : null;
  const herdrViewers = registerHerdrSessionRoutes({
    app, upgradeWebSocket, adapter: options.herdrSessions, getPrincipal, terminalOwnerIds: terminalRuntimeOwnerIds,
    terminalLiveOwnership, terminalInputActivity: terminalAgents.inputActivity,
  });
  return {
    ...herdrViewers,
    desktopLinks,
    /** Herdr viewers first, then each desktop is told and its link closed; adapters end in the background. */
    drain(): void {
      herdrViewers.drain();
      desktopViewers?.drain();
      desktopLinks?.drain().catch((error: unknown) => {
        console.warn("[desktop-link] shutdown failed:", error instanceof Error ? error.name : "UnknownError");
      });
    },
  };
}
