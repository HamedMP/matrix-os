import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";

const RuntimeUidSchema = z.number().int().nonnegative();
const ZELLIJ_INHERITED_KEYS = new Set([
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);

export function createTerminalRuntimeEnvironment(options: {
  homePath: string;
  uid: number;
  inheritedEnv?: NodeJS.ProcessEnv;
  runtimeDir?: string;
}): Record<string, string> {
  const uid = RuntimeUidSchema.parse(options.uid);
  const homePath = resolve(options.homePath);
  const runtimeDir = resolve(options.runtimeDir ?? `/run/user/${uid}`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.inheritedEnv ?? process.env)) {
    if (typeof value !== "string" || ZELLIJ_INHERITED_KEYS.has(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: homePath,
    MATRIX_HOME: homePath,
    ZELLIJ_CONFIG_DIR: join(homePath, "system", "zellij"),
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtimeDir, "bus")}`,
  };
}

export async function assertTerminalRuntimeDirectory(runtimeDirInput: string, uidInput: number): Promise<void> {
  const uid = RuntimeUidSchema.parse(uidInput);
  const runtimeDir = resolve(runtimeDirInput);
  try {
    const stats = await lstat(runtimeDir);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== uid) {
      throw new Error("terminal_runtime_directory_unavailable");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "terminal_runtime_directory_unavailable") throw error;
    throw new Error("terminal_runtime_directory_unavailable", { cause: error });
  }
}
