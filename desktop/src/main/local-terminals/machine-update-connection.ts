// One private OpenSSH transport for the identity read and every updater dial,
// including native Windows SCP. A closed master MUST NOT fall back to a dial.
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";
import { MachineCoreIdSchema } from "../../shared/local-terminals";

const TIMEOUT_MS = 20_000;
const Status = z.object({ core: z.object({ id: MachineCoreIdSchema }) });

export interface MachineUpdateConnection {
  coreId: string;
  /** Validated OpenSSH argv, ending in `-- destination`, without a remote command. */
  ssh: readonly string[];
}
export type WithUpdateConnection = (
  env: Record<string, string>, connection: MachineUpdateConnection,
  work: (env: Record<string, string>) => Promise<void>,
) => Promise<void>;

export class MachineCoreChangedError extends Error {
  constructor() { super("machine core identity could not be proved"); this.name = "MachineCoreChangedError"; }
}
export class MachineCoreUnsupportedError extends Error {
  constructor() { super("machine core update transport unsupported"); this.name = "MachineCoreUnsupportedError"; }
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
// No login shell: a login profile can change HOME/PATH after sshd set them.
const UNIX_STATUS = "sh -c 'for c in herdr-core hc \"$HOME/.local/bin/herdr-core\" \"$HOME/.local/bin/hc\"; do "
  + "if command -v \"$c\" >/dev/null 2>&1; then exec \"$c\" server status --json; fi; done; exit 127'";
// Herdr 0.1.19's native Windows discovery path. cmd /d /c works whether
// OpenSSH's default shell is cmd or PowerShell, without a Unix shell or hc.
const WINDOWS_STATUS = 'cmd /d /c ".\\AppData\\Local\\Programs\\herdr-core\\herdr-core.exe server status --json"';

function capture(binary: string, args: readonly string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, [...args], { env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function executable(name: string, env: Record<string, string>): Promise<string> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    try { await access(path, constants.X_OK); return await realpath(path); }
    catch (error: unknown) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error(`missing update transport: ${name}`);
}

/** OpenSSH's -S overrides config; remove Herdr's -S before selecting our socket.
 * Put all no-fallback options first: OpenSSH keeps the first -o value. SCP also
 * uses this shim via -S, so SFTP and the Windows installer cannot dial afresh.
 */
function sshShim(binary: string, socket: string): string {
  return `#!/bin/sh
set -eu
n=$#
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  case "$a" in
    -S) [ "$n" -gt 0 ] || exit 2; shift; n=$((n - 1));;
    -S?*) ;;
    *) set -- "$@" "$a";;
  esac
done
exec ${quote(binary)} -S ${quote(socket)} -o ControlMaster=no -o ProxyCommand=false -o ProxyJump=none -o BatchMode=yes -o ConnectTimeout=10 "$@"
`;
}

export const withVerifiedUpdateConnection: WithUpdateConnection = async (env, connection, work) => {
  if (!MachineCoreIdSchema.safeParse(connection.coreId).success) throw new MachineCoreChangedError();
  // The bundled app currently ships on Unix. Windows REMOTE targets use their
  // native commands and SCP below; Windows LOCAL OpenSSH has no multiplexing.
  if (process.platform === "win32") throw new MachineCoreUnsupportedError();
  const [routeBinary, ...route] = connection.ssh;
  const end = route.lastIndexOf("--");
  if (!routeBinary || end < 0 || end !== route.length - 2) throw new MachineCoreUnsupportedError();
  const destination = route[end + 1]!;
  const ssh = await executable("ssh", env);
  const scp = await executable("scp", env);
  const dir = await mkdtemp(join(env.XDG_RUNTIME_DIR ?? tmpdir(), "mxu-"));
  const socket = join(dir, "control");
  let stop: (() => Promise<void>) | undefined;
  try {
    if (socket.length > 100) throw new Error("update control path too long");
    const shim = join(dir, "ssh");
    await writeFile(shim, sshShim(ssh, socket), { mode: 0o700, flag: "wx" });
    await writeFile(join(dir, "scp"), `#!/bin/sh\nexec ${quote(scp)} -S ${quote(shim)} "$@"\n`, { mode: 0o700, flag: "wx" });
    const pinnedEnv = { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ""}`, HC_SSH: shim };
    // Independent of both the person's ControlPath and the app's login master
    // (#3635). Only this job owns its lifetime; it is never persisted.
    const master = spawn(routeBinary, [
      "-M", "-N", "-S", socket, "-o", "ControlMaster=yes", "-o", "ControlPersist=no",
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", ...route,
    ], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let failure: Error | undefined;
    // Drain stderr without retaining provider/host details in UI state.
    master.stderr.resume();
    master.on("error", (error) => { failure = error; });
    const exited = new Promise<void>((resolve) => master.once("close", () => resolve()));
    stop = async () => {
      master.kill();
      const timer = setTimeout(() => master.kill("SIGKILL"), 2_000);
      try { await exited; } finally { clearTimeout(timer); }
    };
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      if (failure) throw failure;
      if (master.exitCode !== null || master.signalCode !== null) throw new Error("update SSH connection closed");
      try { if ((await stat(socket)).isSocket()) break; }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Date.now() >= deadline) throw new Error("update SSH connection timed out");
      await delay(50);
    }
    let live: string;
    try {
      let output: string;
      try { output = await capture(shim, ["--", destination, UNIX_STATUS], pinnedEnv); }
      catch (unixError: unknown) {
        // Herdr also tries native Windows after a Unix discovery failure.
        console.debug("[local-terminals] trying native core discovery:", unixError instanceof Error ? unixError.name : "UnknownError");
        output = await capture(shim, ["--", destination, WINDOWS_STATUS], pinnedEnv);
      }
      live = Status.parse(JSON.parse(output)).core.id;
    } catch (error: unknown) {
      console.warn("[local-terminals] update core identity unavailable:", error instanceof Error ? error.name : "UnknownError");
      throw new MachineCoreChangedError();
    }
    if (live !== connection.coreId) throw new MachineCoreChangedError();
    await work(pinnedEnv);
  } finally {
    if (stop) await stop();
    await rm(dir, { recursive: true, force: true });
  }
};
