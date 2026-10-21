import type { AgentLaunchSpec } from "../agent-launcher.js";

export function agentLaunchTerminalCommand(launch: AgentLaunchSpec): string[] {
  return ["env", ...(launch.inheritEnv === false ? ["-i"] : []), ...Object.entries(launch.env).map(([key, value]) => `${key}=${value}`), launch.command, ...launch.args];
}
