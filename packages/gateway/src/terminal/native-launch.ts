import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { resolveWithinHome } from "../path-security.js";
import { TerminalHostLaunchSchema } from "./host-descriptor.js";
export const TerminalHarnessSchema = z.enum(["claude", "codex", "hermes", "opencode", "pi"]);
export type TerminalHarness = z.infer<typeof TerminalHarnessSchema>;
/** A user selects a server-owned builder. No argv/env/identity/target/permission overrides. */
export const TerminalManagedLaunchSchema = z.object({ harness: TerminalHarnessSchema }).strict();
export type TerminalManagedLaunch = z.infer<typeof TerminalManagedLaunchSchema>;
const commands: Record<TerminalHarness, { command: string; displayName: string; args: string[] }> = {
  claude: { command: "claude", displayName: "Claude", args: [] },
  codex: { command: "codex", displayName: "Codex", args: ["--no-alt-screen"] },
  hermes: { command: "hermes", displayName: "Hermes", args: [] },
  opencode: { command: "opencode", displayName: "OpenCode", args: [] },
  pi: { command: "pi", displayName: "Pi", args: [] },
};
/** Original menu command, resolved by the owner's login shell. No source authority. */
export function terminalNativeOrdinaryCommand(raw: TerminalManagedLaunch): string[] {
  const selected = commands[TerminalManagedLaunchSchema.parse(raw).harness];
  return ["sh", "-lc", [selected.command, ...selected.args].join(" ")];
}
type Runner = (command: string, args: string[], options: { cwd: string; timeout: number; env: Record<string, string> }) => Promise<{ stdout: string; stderr: string }>;
/** Interactive native CLI commands, not Chat wrappers. Inherits each native permission
 * configuration and installs no tool/hook/extension, Bash permission or grant. */
export function createTerminalNativeLauncher(options: { homePath: string; nodePrefix?: string; searchDirectories?: string[]; runCommand?: Runner }) {
  const home = resolve(options.homePath), prefix = resolve(options.nodePrefix ?? process.env.MATRIX_NODE_PREFIX ?? "/opt/matrix/runtime/node");
  const directories = options.searchDirectories ?? [join(home, ".local", "bin"), join(prefix, "bin"), "/opt/matrix/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  if (directories.length > 32 || directories.some(path => !isAbsolute(path) || /[\0\r\n:]/.test(path))) throw new Error("Terminal launch unavailable");
  const env = { HOME: home, MATRIX_HOME: home, MATRIX_NODE_PREFIX: prefix, PATH: directories.join(":"), TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8" };
  const exec = promisify(execFile), run: Runner = options.runCommand ?? ((command, args, input) => exec(command, args, { ...input, encoding: "utf8", maxBuffer: 128 * 1024 }));
  async function executable(harness: TerminalHarness) {
    for (const directory of directories) {
      const candidate = join(directory, commands[harness].command);
      try { await access(candidate, constants.X_OK); const path = await realpath(candidate); if ((await stat(path)).isFile()) return path; }
      catch (error) { if (!(error instanceof Error && "code" in error && ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code)))) throw error; }
    }
    return undefined;
  }
  async function ready(harness: TerminalHarness) {
    const path = await executable(harness);
    if (!path) return { installState: "missing" as const };
    try { const version = await run(path, ["--version"], { cwd: home, timeout: 5000, env }); return { installState: "installed" as const, path, version: (version.stdout || version.stderr).trim().split("\n")[0]?.slice(0, 256) }; }
    catch (error) { console.warn("[terminal-launch] Native readiness unavailable", error instanceof Error ? error.name : "UnknownError"); return { installState: "unknown" as const }; }
  }
  return {
    async status(harness: TerminalHarness) {
      const selected = TerminalHarnessSchema.parse(harness), state = await ready(selected);
      return { id: selected, command: commands[selected].command, displayName: commands[selected].displayName,
        installState: state.installState, installed: state.installState === "unknown" ? null : state.installState === "installed",
        authState: "unknown" as const, workspaceCompatibility: "not_applicable" as const,
        ...(state.installState === "installed" && state.version ? { version: state.version } : {}),
        errorCode: state.installState === "installed" ? null : state.installState === "missing" ? "agent_missing" : "agent_check_failed" };
    },
    async build(raw: TerminalManagedLaunch, cwd: string) {
      const { harness } = TerminalManagedLaunchSchema.parse(raw), path = resolveWithinHome(home, cwd);
      if (!path || cwd.includes("\0")) throw new Error("Terminal launch unavailable");
      const [actualHome, actualCwd] = await Promise.all([realpath(home), realpath(path)]), rel = relative(actualHome, actualCwd);
      if (rel.startsWith("..") || isAbsolute(rel) || !(await stat(actualCwd)).isDirectory()) throw new Error("Terminal launch unavailable");
      const state = await ready(harness);
      if (state.installState !== "installed") throw new Error("Terminal launch unavailable");
      return TerminalHostLaunchSchema.parse({ command: state.path, args: [...commands[harness].args], cwd: actualCwd, env, inheritEnv: false });
    },
  };
}
