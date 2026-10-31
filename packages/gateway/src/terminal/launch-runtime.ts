import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadInstalledTerminalRuntimeGeneration } from "@matrix-os/terminal-runtime";
import { validateTerminalClosure } from "@matrix-os/terminal-runtime/generation-closure";
import type { RoutineCliRuntime } from "../bots/routine-cli-runtime.js";
import type { TerminalWorkspaceRouteRuntime } from "../shell/workspace-routes.js";
import { createCanonicalTerminalLaunch } from "./canonical-launch.js";
import { createTerminalHostService } from "./host-service.js";
import { createTerminalNativeLauncher } from "./native-launch.js";
/** Startup preflight only. Missing proof/package/manager preserves ordinary fixed
 * native launching. No fallback is attempted after a host may have dispatched. */
export async function createTerminalLaunchRuntime(options: {
  homePath: string; runtime: TerminalWorkspaceRouteRuntime; ownerIds: readonly string[]; computerId: string;
  routines?: { runtime: RoutineCliRuntime; binPath: string; endpoint: string };
}) {
  const runtimeRoot = process.env.MATRIX_TERMINAL_RUNTIME_ROOT ?? "/opt/matrix/terminal-runtime";
  let generation = "unavailable", host: ReturnType<typeof createTerminalHostService> | undefined;
  try {
    if (process.platform !== "linux") throw new Error("Native terminal proof unavailable");
    generation = await loadInstalledTerminalRuntimeGeneration(process.env.MATRIX_APP_DIR ?? "/opt/matrix/app", { terminalRuntimeRoot: runtimeRoot });
    await validateTerminalClosure(join(runtimeRoot, "generations", generation), generation);
    const uid = process.getuid?.(); if (uid === undefined) throw new Error("Native terminal proof unavailable");
    await promisify(execFile)("/usr/bin/systemctl", ["--user", "show", "--property=Version"], { timeout: 5000, maxBuffer: 8192,
      env: { HOME: options.homePath, PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` } });
    host = createTerminalHostService({ homePath: options.homePath, generation, runtimeRoot });
  } catch (error) { console.warn("[terminal-launch] Routine source prerequisite unavailable", error instanceof Error ? error.name : "UnknownError"); }
  const launcher = createTerminalNativeLauncher({ homePath: options.homePath });
  const admission = createCanonicalTerminalLaunch({ ...options, host, launcher, generation });
  return { admission, hermesStatus: () => launcher.status("hermes"), async close() { await admission.close(); await host?.close(); } };
}
