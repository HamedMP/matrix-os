// Runs "This Computer" terminals in a private herdr-core session
// (specs/651-desktop-terminal-window, Local Backend). The core and its holder
// outlive the app, so terminals survive a restart. Its state, config and
// sockets live in app-private directories; the user's own herdr is untouched.
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { SshTargetSchema, type LocalMachine, type LocalTerminalAgent, type LocalTerminalFact, type SshOptions } from "../../shared/local-terminals";
import { sshLoginArgv, sshVia } from "./ssh-command";
import { createMachineSshStore, machineSshMatches } from "./machine-ssh-store";
import { findTailscale, tailscalePeers, type TailscalePeersResult } from "./tailscale";
import { createMachineCore, type MachineCoreResult, type MachineCoreRunner } from "./machine-core";
import { addMachine, listMachines, type AddMachineResult } from "./hc-machines";
import { installLocalStatusReporter } from "./status-reporter";
import { describeError } from "./describe-error";
import { connectHc, HcVersionMismatchError, type HcConnection, type HcSocket } from "./hc-client";
import { createHcSessions, TERMINAL_TITLE_LABEL, type AttachmentSlots, type HcSessionSink } from "./hc-sessions";
import {
  createLocalTerminalEvents, FINISHED_SEEN_LABEL, HERDR_SEEN_LABEL,
  type LocalTerminalEvents, type LocalTerminalEventsOptions,
} from "./hc-events";

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
  /** Shared with the window's other hosts, so the attachment budget holds across them. */
  slots?: AttachmentSlots;
  now?: () => number;
  /** Follows status changes; replaced in tests. */
  createEvents?: (options: LocalTerminalEventsOptions) => LocalTerminalEvents;
  /** Runs the bundled core's CLI (machine install and update); replaced in tests. */
  runCoreCli?: MachineCoreRunner;
}

export class LocalTerminalUnknownError extends Error {
  constructor() { super("local terminal is not listed"); this.name = "LocalTerminalUnknownError"; }
}

export interface LocalTerminalHostSink extends HcSessionSink {
  /** Status facts changed (spec 2706 layer 4). */
  facts?(terminals: LocalTerminalFact[]): void;
}

export function createLocalTerminalHost(options: LocalTerminalHostOptions, sink: LocalTerminalHostSink) {
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

  const sessions = createHcSessions({ ensure, slots: options.slots, now }, sink);
  const machineSsh = createMachineSshStore(options.dataDir);
  // The app's own core on added machines, through the bundled core's CLI.
  const machineCore = createMachineCore({
    cli: async () => {
      try {
        return { binary: await prepare(), env: coreEnv() };
      } catch (error: unknown) {
        if (error instanceof LocalRuntimeMissingError) return null;
        throw error;
      }
    },
    ...(options.runCoreCli ? { run: options.runCoreCli } : {}),
  });
  // Changes on every unwatch: a watch still waiting for the core must not start after its window left.
  let watchEpoch = 0;
  const events = (options.createEvents ?? createLocalTerminalEvents)({
    open: () => options.openSocket(socketPath),
    expectedVersion: options.expectedVersion,
    onChange: (terminals) => sink.facts?.(terminals),
    now,
  });

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
      launch: { agent?: LocalTerminalAgent; folder?: string; machine?: string } = {},
    ): Promise<string | null> {
      if (launch.machine) {
        // That machine's own shell, in its home (spec 2706 layer 7). Its address is `machine/t7`.
        const id = await sessions.run({ on: launch.machine, size, no_parent: true, no_notify: true, wait: false });
        return id && !id.includes("/") ? `${launch.machine}/${id}` : id;
      }
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

    /**
     * Follows status (herdr-core `events.subscribe`) once the core is running,
     * and returns what is known now; changes go to the sink's `facts`.
     */
    async watch(): Promise<LocalTerminalFact[]> {
      const startedIn = watchEpoch;
      await ensure();
      if (watchEpoch !== startedIn) throw new Error("local terminal watch ended");
      events.start();
      return events.facts();
    },

    /** Stops following status: the Terminal window closed or reloaded. */
    unwatch(): void {
      watchEpoch += 1;
      events.stop();
    },

    /**
     * The person opened this terminal. Uses Herdr's own label (the turn they
     * saw), so every client of this core agrees; a finished terminal gets
     * its own label, since its turn no longer changes.
     */
    async seen(id: string): Promise<void> {
      const fact = events.fact(id);
      if (!fact) throw new LocalTerminalUnknownError();
      const labels = fact.finished ? { [FINISHED_SEEN_LABEL]: "1" } : { [HERDR_SEEN_LABEL]: String(fact.turn) };
      const core = await ensure();
      await core.call("terminal.label", { terminal: id, labels });
    },

    /**
     * A terminal on this device running `ssh <target>`: where the person checks
     * a host key they have not accepted yet, or types a password, themselves.
     * The target was validated (never an option); `--` ends ssh's options anyway.
     */
    sshLogin(target: string, size: { cols: number; rows: number }, ssh?: SshOptions): Promise<string | null> {
      const unset = CORE_ONLY_ENV.flatMap((name) => ["-u", name]);
      // `user@host:port` is herdr-core's form; OpenSSH takes the port as `-p`. No BatchMode: the person answers here.
      return sessions.run({
        argv: ["/usr/bin/env", ...unset, ...sshLoginArgv(target, ssh, ssh?.tailscaleSsh ? findTailscale() : null)],
        cwd: options.home,
        env: { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "MatrixOS" },
        labels: { [TERMINAL_TITLE_LABEL]: `ssh ${target}`.slice(0, 64) },
        size, no_parent: true, no_notify: true, wait: false,
      });
    },

    /** Machines this core reaches over ssh, with their line state now and how the app added them. */
    async machines(): Promise<LocalMachine[]> {
      const [machines, saved] = await Promise.all([ensure().then(listMachines), machineSsh.all()]);
      return machines.map((machine) => {
        const entry = saved[machine.name];
        if (!entry) return machine;
        if (!machineSshMatches(entry, machine)) {
          // The name now belongs to another host: its old settings must not reach it.
          // Only the entry that was checked: settings saved by a re-add while this listing waited stay.
          void machineSsh.removeIfUnchanged(machine.name, entry).catch((error: unknown) => console.warn("[local-terminals] stale machine ssh not removed:", describeError(error)));
          return machine;
        }
        return { ...machine, target: entry.target, ...(entry.ssh ? { ssh: entry.ssh } : {}) };
      });
    },

    /** Open in terminal for an added machine, the way it was added. Null when the core does not know it. */
    async machineLogin(name: string, size: { cols: number; rows: number }): Promise<string | null> {
      const [entry, current] = await Promise.all([
        machineSsh.get(name), ensure().then(listMachines).then((machines) => machines.find((machine) => machine.name === name)),
      ]);
      if (!current) return null;
      const saved = entry && machineSshMatches(entry, current) ? entry : undefined;
      const target = saved?.target ?? current.target;
      // A machine added with a command (via) elsewhere has no target to ssh to.
      if (!target || !SshTargetSchema.safeParse(target).success) return null;
      return this.sshLogin(target, size, saved?.ssh);
    },

    async addMachine(input: { target: string; name?: string; ssh?: SshOptions }): Promise<AddMachineResult> {
      const via = sshVia(input.target, input.ssh, input.ssh?.tailscaleSsh ? findTailscale() : null);
      const result = await addMachine(await ensure(), { target: input.target, ...(input.name ? { name: input.name } : {}), ...(via ? { via } : {}) });
      if (result.ok) {
        try {
          await machineSsh.set(result.machine.name, {
            target: input.target, ...(input.ssh ? { ssh: input.ssh } : {}), coreTarget: result.machine.target,
          });
        } catch (error: unknown) {
          // Without its settings the machine would be reached the wrong way later: take it back out so a retry starts clean.
          await (await ensure()).call("machine.rm", { machine: result.machine.name })
            .catch((rollback: unknown) => console.warn("[local-terminals] add rollback failed:", describeError(rollback)));
          throw error;
        }
        return { ok: true, machine: { ...result.machine, target: input.target, ...(input.ssh ? { ssh: input.ssh } : {}) } };
      }
      return result;
    },

    /** This Mac's tailnet peers, for one-click Add machine. */
    tailscalePeers(): Promise<TailscalePeersResult> {
      return tailscalePeers();
    },

    /** Adds a machine that has no core or an old one, installing the app's own core there. */
    installMachine(input: { target: string; name: string; ssh?: SshOptions }): Promise<MachineCoreResult> {
      const via = sshVia(input.target, input.ssh, input.ssh?.tailscaleSsh ? findTailscale() : null);
      return machineCore.install({ name: input.name, target: input.target, ...(via ? { via } : {}) });
    },

    /** Brings an added machine's core to the app's version; its terminals keep running. */
    updateMachine(name: string): Promise<MachineCoreResult> {
      return machineCore.update(name);
    },

    /** Forgets a machine; its terminals keep running there. */
    async removeMachine(name: string): Promise<void> {
      await (await ensure()).call("machine.rm", { machine: name });
      // The machine is gone, so this is done. Settings left behind are inert: a later add of the
      // name overwrites them, and they never reach a different host (machineSshMatches).
      await machineSsh.remove(name).catch((error: unknown) => console.warn("[local-terminals] removed machine's ssh not cleared:", describeError(error)));
    },

    /** Dials a machine now (after a login in a terminal) instead of at its next retry. */
    async connectMachine(name: string): Promise<void> {
      await (await ensure()).call("machine.connect", { machine: name }, 30_000);
    },

    /** Removes a finished terminal from the list; the core refuses a live one. */
    async remove(id: string): Promise<void> {
      const core = await ensure();
      await core.call("terminal.rm", { terminal: id });
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
      events.stop();
      sessions.drop();
      connection?.close();
      connection = null;
    },
  };
}

export type LocalTerminalHost = ReturnType<typeof createLocalTerminalHost>;
