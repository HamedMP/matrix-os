import { MATRIX_SHARED_BROWSER_LAUNCH_POINTER } from "../../../contracts/matrix-agent-orientation.mjs";
import type { AgentLaunchSpec } from "../agent-launcher.js";
import type { NativeSharedBrowserRun } from "./native-shared-browser-run.js";
import { NATIVE_SHARED_BROWSER_SERVER, NATIVE_SHARED_BROWSER_TOOL } from "./native-shared-browser-run.js";

/** Merge only a gateway-created stdio server; never accept owner/model config. */
export function configureClaudeSharedBrowser(launch: AgentLaunchSpec, run: NativeSharedBrowserRun): void {
  if (!launch.args.includes("--strict-mcp-config") || !launch.args.includes("--no-chrome")) throw new Error("Browser launch unavailable");
  const index = launch.args.indexOf("--mcp-config");
  const config = index < 0 ? { mcpServers: {} } : JSON.parse(launch.args[index + 1]!);
  const server = { ...run.mcpServer, timeout: 390_000,
    // Claude expands documented ${VAR} references. No bearer in argv/config.
    env: { MATRIX_SHARED_BROWSER_TOKEN: "${MATRIX_SHARED_BROWSER_TOKEN}", MATRIX_SHARED_BROWSER_GATEWAY_PORT: "${MATRIX_SHARED_BROWSER_GATEWAY_PORT}" } };
  config.mcpServers[NATIVE_SHARED_BROWSER_SERVER] = server;
  if (index < 0) { const separator = launch.args.indexOf("--"); launch.args.splice(separator < 0 ? launch.args.length : separator, 0, "--mcp-config", JSON.stringify(config)); }
  else launch.args[index + 1] = JSON.stringify(config);
  Object.assign(launch.env, run.mcpServer.env);
  configureClaudeSharedBrowserPresentation(launch);
}

/** Stable launch arguments used for source comparison before any Browser Run lease. */
export function configureClaudeSharedBrowserPresentation(launch: AgentLaunchSpec): void {
  // Only this exact gateway-owned tool is pre-approved natively. Its broker
  // still checks the immutable Full access or supervised lease before dispatch.
  const allowed = launch.args.indexOf("--allowedTools");
  if (allowed >= 0) launch.args[allowed + 1] += `,${NATIVE_SHARED_BROWSER_TOOL}`;
  else { const separator = launch.args.indexOf("--"); launch.args.splice(separator < 0 ? launch.args.length : separator, 0, "--allowedTools", NATIVE_SHARED_BROWSER_TOOL); }

  const orientation = launch.args.indexOf("--append-system-prompt");
  if (orientation >= 0) launch.args[orientation + 1] += `\n\n${MATRIX_SHARED_BROWSER_LAUNCH_POINTER}`;
  else { const separator = launch.args.indexOf("--"); launch.args.splice(separator < 0 ? launch.args.length : separator, 0, "--append-system-prompt", MATRIX_SHARED_BROWSER_LAUNCH_POINTER); }
}
