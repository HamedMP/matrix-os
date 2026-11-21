import { join } from "node:path";
import { z } from "zod/v4";
import type { TerminalHostDescriptor } from "./host-descriptor.js";

const EnvironmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/), z.string().max(8192).refine(value => !value.includes("\0")));
const LoginEnvironmentFrame = z.strictObject({ type: z.literal("terminal.login-environment"), env: EnvironmentSchema });
const NON_OWNER_KEYS = /^(?:INVOCATION_ID|SYSTEMD_EXEC_PID|JOURNAL_STREAM|LOG_NAMESPACE|NOTIFY_SOCKET|WATCHDOG_.*|LISTEN_.*|NODE_CHANNEL_.*|ZELLIJ(?:_.*)?|MATRIX_TERMINAL_ROUTINE_SOCKET)$/;

/** Match the existing Zellij daemon's owner-manager environment, without preserving
 * its service bookkeeping or inheriting it into the pinned Node helper. */
export function terminalLoginEnvironment(launch: TerminalHostDescriptor["launch"], manager: NodeJS.ProcessEnv, uid: number) {
  const env = Object.fromEntries(Object.entries(manager).filter(([key, value]) =>
    typeof value === "string" && !NON_OWNER_KEYS.test(key))) as Record<string, string>;
  const runtimeDir = manager.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return validateTerminalLoginEnvironment({
    type: "terminal.login-environment",
    env: { ...env, ...launch.env, ZELLIJ_CONFIG_DIR: join(launch.env.HOME, "system", "zellij"),
      XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: manager.DBUS_SESSION_BUS_ADDRESS || `unix:path=${join(runtimeDir, "bus")}` },
  });
}

export function validateTerminalLoginEnvironment(raw: unknown) {
  if (Buffer.byteLength(JSON.stringify(raw) ?? "") > 65536) throw new Error("Terminal login environment unavailable");
  return LoginEnvironmentFrame.parse(raw);
}
