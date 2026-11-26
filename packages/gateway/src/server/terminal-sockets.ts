/** Register every terminal socket: Matrix tabs, the terminal event stream, and Herdr sessions (spec 2701). */
import type { HerdrAdapter } from "../herdr/adapter.js";
import { registerHerdrSessionRoutes } from "../herdr/register.js";
import { registerTerminalEventWebSocket } from "../terminal-agent/events-ws.js";
import type { TerminalAgentServices } from "../terminal-agent/services.js";
import { registerTerminalWebSocketRoutes } from "./terminal-ws-routes.js";

type TerminalTabSocketOptions = Parameters<typeof registerTerminalWebSocketRoutes>[0];

export function registerTerminalSockets(options: Omit<TerminalTabSocketOptions, "terminalInputActivity"> & {
  terminalAgents: TerminalAgentServices;
  herdrSessions: HerdrAdapter | null;
}) {
  const { app, upgradeWebSocket, getPrincipal, terminalRuntimeOwnerIds, terminalLiveOwnership, terminalAgents } = options;
  registerTerminalWebSocketRoutes({ ...options, terminalInputActivity: terminalAgents.inputActivity });
  registerTerminalEventWebSocket({ app, upgradeWebSocket, hub: terminalAgents.events, getPrincipal, terminalOwnerIds: terminalRuntimeOwnerIds });
  return registerHerdrSessionRoutes({
    app, upgradeWebSocket, adapter: options.herdrSessions, getPrincipal, terminalOwnerIds: terminalRuntimeOwnerIds,
    terminalLiveOwnership, terminalInputActivity: terminalAgents.inputActivity,
  });
}
