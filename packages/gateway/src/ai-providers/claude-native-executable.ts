import { constants, accessSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";

/**
 * Settings owns the native CLI protocol, so prefer the managed installation over
 * an older self-updater in HOME/.local/bin. Resolve at use time: installation and
 * upgrade workflows can change availability without restarting the gateway.
 * Executability is not identity proof; auth status must still prove exact HOME.
 */
export function resolveClaudeNativeExecutable(homePath: string, environment = buildAgentRuntimeEnvironment(homePath)): string {
  const prefix = environment.MATRIX_NODE_PREFIX?.trim() || "/opt/matrix/runtime/node";
  const candidates = [join(prefix, "bin/claude"), join(homePath, ".local/bin/claude"),
    ...(environment.PATH ?? "").split(delimiter).filter(isAbsolute).map(directory => join(directory, "claude"))];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)
        || !["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) throw error;
    }
  }
  // Preserve the existing unavailable/error handling when Claude is uninstalled.
  return "claude";
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Pin the same executable through login-shell startup files and PATH changes. */
export function claudeNativeTerminalCommand(homePath: string): string {
  const environment = buildAgentRuntimeEnvironment(homePath);
  const executable = resolveClaudeNativeExecutable(homePath, environment);
  return `sh -lc ${quote(`export MATRIX_NODE_PREFIX=${quote(environment.MATRIX_NODE_PREFIX!)}; export PATH=${quote(environment.PATH!)}; exec ${quote(executable)}`)}`;
}
