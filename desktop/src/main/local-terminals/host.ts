// Runs "This Computer" terminals in a private herdr-core session
// (specs/651-desktop-terminal-window, Local Backend). The core and its holder
// outlive the app, so terminals survive a restart. Its state, config and
// sockets live in app-private directories; the user's own herdr is untouched.
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { LocalTerminalAgent } from "../../shared/local-terminals";
import { installLocalStatusReporter } from "./status-reporter";
import { describeError } from "./describe-error";
import { connectHc, HcVersionMismatchError, type HcConnection, type HcSocket } from "./hc-client";
import { createHcSessions, type HcSessionSink } from "./hc-sessions";

const SESSION = "mx";
// The longest socket herdr-core creates is `<session>.holder.<8 hex>.sock`.
const LONGEST_SOCKET_NAME = `${SESSION}.holder.00000000.sock`;
const SOCKET_PATH_LIMIT = 100;
const START_TIMEOUT_MS = 5_000;
const RESTART_WINDOW_MS = 5 * 60_000;
const MAX_STARTS_PER_WINDOW = 3;
const SHELL_ENV_NAMES = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "TMPDIR", "SSH_AUTH_SOCK"]);
// Variables that exist only to isolate the core must not reach the user's shell.
const CORE_ONLY_ENV = ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "HC_SESSION", "HC_SCOPE", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"];

// Fixed command lines for the agents the window can start. Codex runs without
// its shared daemon, which would otherwise run later sessions as the first one.
const AGENT_COMMANDS: Record<LocalTerminalAgent, string> = {
  claude: "claude",
  codex: "codex --no-daemon",
  opencode: "opencode",
  pi: "pi",
};
// Runs the agent in the user's interactive login shell, so PATH entries from
// `.zshrc` or `.bashrc` apply as in their own terminal, then leaves that shell
// open, as Herdr does. `$1` is the shell and `$2` the fixed agent command.
const AGENT_LAUNCHER = '"$1" -l -i -c "$2"; exec "$1" -l';

export class LocalTerminalFolderError extends Error {
  constructor() { super("terminal folder is not a folder in your home"); this.name = "LocalTerminalFolderError"; }
}
// A dial fails this way only when no core is listening on the socket.
const NO_CORE_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

export type LocalTerminalHostStatus = "ready" | "not-installed" | "unavailable" | "version-mismatch";

export class LocalRuntimeMissingError extends Error {
  constructor() { super("local terminal runtime is not installed"); this.name = "LocalRuntimeMissingError"; }
}

/** Only an allowlist of the app's environment reaches the core and its shells. */
export function localShellEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (SHELL_ENV_NAMES.has(name) || name.startsWith("LC_"))) env[name] = value;
  }
  return env;
}

export interface LocalTerminalHostOptions {
  /** The pinned herdr-core binary, or null when this build has none. */
  binaryPath: string | null;
  expectedVersion: string;
  /** Short private directory for sockets (Unix socket paths are length-limited). */
  runtimeDir: string;
  /** Private directory for the core's state and config. */
  dataDir: string;
  home: string;
  shell: string;
  env: NodeJS.ProcessEnv;
  uid: number;
  startCore(binaryPath: string, env: Record<string, string>, timeoutMs: number): Promise<void>;
  openSocket(path: string): HcSocket;
  now?: () => number;
}

export function createLocalTerminalHost(options: LocalTerminalHostOptions, sink: HcSessionSink) {
  const now = options.now ?? Date.now;
  const socketPath = join(options.runtimeDir, "herdr-core", `${SESSION}.sock`);
  const starts: number[] = [];
  let connection: HcConnection | null = null;
  let connecting: Promise<HcConnection> | null = null;
  let status: LocalTerminalHostStatus = "unavailable";
  let disposed = false;

  function coreEnv(): Record<string, string> {
    return {
      ...localShellEnv(options.env),
      HC_SESSION: SESSION,
      XDG_STATE_HOME: join(options.dataDir, "state"),
      XDG_CONFIG_HOME: join(options.dataDir, "config"),
      XDG_RUNTIME_DIR: options.runtimeDir,
    };
  }

  async function privateDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== options.uid || (info.mode & 0o077) !== 0) {
      throw new Error("local terminal directory is not private");
    }
  }

  async function prepare(): Promise<string> {
    if (!options.binaryPath) throw new LocalRuntimeMissingError();
    // Resolve once and run exactly what was checked.
    const binaryPath = await realpath(options.binaryPath);
    const binary = await lstat(binaryPath);
    if (!binary.isFile() || (binary.mode & 0o111) === 0) throw new Error("local terminal runtime is not executable");
    if (join(options.runtimeDir, "herdr-core", LONGEST_SOCKET_NAME).length > SOCKET_PATH_LIMIT) {
      throw new Error("local terminal socket path is too long");
    }
    await privateDir(options.runtimeDir);
    await privateDir(options.dataDir);
    await privateDir(join(options.dataDir, "state"));
    await privateDir(join(options.dataDir, "config"));
    await privateDir(join(options.dataDir, "bin"));
    await installLocalStatusReporter(options.dataDir);
    return binaryPath;
  }

  const dial = () => connectHc({ open: () => options.openSocket(socketPath), expectedVersion: options.expectedVersion });

  async function open(): Promise<HcConnection> {
    const binary = await prepare();
    try {
      return await dial();
    } catch (error: unknown) {
      // Only "nothing is listening" is answered by starting a core. A core
      // that is there but refuses, stalls or speaks another version is
      // reported as it is and never restarted over.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (error instanceof HcVersionMismatchError || typeof code !== "string" || !NO_CORE_CODES.has(code)) throw error;
      const cutoff = now() - RESTART_WINDOW_MS;
      while (starts.length > 0 && starts[0]! < cutoff) starts.shift();
      if (starts.length >= MAX_STARTS_PER_WINDOW) throw new Error("local terminal runtime keeps failing");
      starts.push(now());
      await options.startCore(binary, coreEnv(), START_TIMEOUT_MS);
      return dial();
    }
  }

  function ensure(): Promise<HcConnection> {
    if (disposed) return Promise.reject(new Error("local terminals are shut down"));
    if (connection) return Promise.resolve(connection);
    connecting ??= open()
      .then((opened) => {
        if (disposed) { opened.close(); throw new Error("local terminals are shut down"); }
        connection = opened;
        status = "ready";
        opened.onDisconnect(() => {
          if (connection !== opened) return;
          connection = null;
          sessions.connectionLost();
        });
        return opened;
      })
      .catch((error: unknown) => {
        status = error instanceof HcVersionMismatchError ? "version-mismatch"
          : error instanceof LocalRuntimeMissingError ? "not-installed" : "unavailable";
        if (status !== "not-installed") console.warn("[local-terminals] runtime unavailable:", describeError(error));
        throw error;
      })
      .finally(() => { connecting = null; });
    return connecting;
  }

  const sessions = createHcSessions({ ensure, now }, sink);

  /** A real folder under home, resolved through symlinks; anything else is refused. */
  async function folderUnderHome(folder: string): Promise<string> {
    const home = await realpath(options.home);
    let resolved: string;
    try {
      resolved = await realpath(join(home, folder));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") throw new LocalTerminalFolderError();
      throw error;
    }
    if (!resolved.startsWith(home + sep) || !(await stat(resolved)).isDirectory()) throw new LocalTerminalFolderError();
    return resolved;
  }

  return {
    status: (): LocalTerminalHostStatus => status,
    list: sessions.list,

    /**
     * Starts the user's login shell, or one of the known agents in it, at home or
     * in a folder under home. Returns null when too many were started just now.
     */
    async create(
      size: { cols: number; rows: number },
      launch: { agent?: LocalTerminalAgent; folder?: string } = {},
    ): Promise<string | null> {
      const cwd = launch.folder ? await folderUnderHome(launch.folder) : options.home;
      const unset = CORE_ONLY_ENV.flatMap((name) => ["-u", name]);
      return sessions.run({
        argv: launch.agent
          ? ["/usr/bin/env", ...unset, "/bin/sh", "-c", AGENT_LAUNCHER, "matrix-agent", options.shell, AGENT_COMMANDS[launch.agent]]
          : ["/usr/bin/env", ...unset, options.shell, "-l"],
        cwd,
        ...(launch.agent ? { labels: { "matrix.agent": launch.agent } } : {}),
        env: { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "MatrixOS",
          PATH: `${join(options.dataDir, "bin")}:${options.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}` },
        size,
        no_parent: true,
        no_notify: true,
        wait: false,
      });
    },

    kill: sessions.kill,
    rename: sessions.rename,
    put: sessions.put,
    attach: sessions.attach,
    acknowledge: sessions.acknowledge,
    input: sessions.input,
    resize: sessions.resize,
    detach: sessions.detach,
    detachAll: sessions.detachAll,

    /** Detaches from the core. The core and its terminals keep running. */
    dispose(): void {
      disposed = true;
      sessions.drop();
      connection?.close();
      connection = null;
    },
  };
}

export type LocalTerminalHost = ReturnType<typeof createLocalTerminalHost>;
