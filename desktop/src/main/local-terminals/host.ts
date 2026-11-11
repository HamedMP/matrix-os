// Runs "This Computer" terminals in a private herdr-core session
// (specs/651-desktop-terminal-window, Local Backend). The core and its holder
// outlive the app, so terminals survive a restart. Its state, config and
// sockets live in app-private directories; the user's own herdr is untouched.
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod/v4";
import {
  LOCAL_TERMINAL_ID_PATTERN, LOCAL_TERMINAL_LIST_MAX, LOCAL_TERMINAL_MAX_OUTPUT_CHARS, LocalTerminalStatusSchema, type LocalTerminal,
  type LocalTerminalAgent,
} from "../../shared/local-terminals";
import { describeError } from "./describe-error";
import { connectHc, HcVersionMismatchError, type HcConnection, type HcSocket, type HcStream } from "./hc-client";

const SESSION = "mx";
// The longest socket herdr-core creates is `<session>.holder.<8 hex>.sock`.
const LONGEST_SOCKET_NAME = `${SESSION}.holder.00000000.sock`;
const SOCKET_PATH_LIMIT = 100;
const START_TIMEOUT_MS = 5_000;
const MAX_ATTACHMENTS = 8;
// Checked when an attachment starts, so a core that keeps answering after the
// attachment was released cannot leave a channel open.
const RESTART_WINDOW_MS = 5 * 60_000;
const MAX_STARTS_PER_WINDOW = 3;
// Terminal creation is rate-limited, never count-capped.
const CREATE_WINDOW_MS = 10_000;
const MAX_CREATES_PER_WINDOW = 10;
const SHELL_ENV_NAMES = new Set(["HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "TMPDIR", "SSH_AUTH_SOCK"]);
// Variables that exist only to isolate the core must not reach the user's shell.
const CORE_ONLY_ENV = ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "HC_SESSION", "HC_SCOPE", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"];

const MAX_TITLE_CHARS = 256;
// Each entry is read on its own: a terminal the core describes in a way this
// build does not expect is skipped instead of hiding every other terminal.
const ListedSchema = z.object({ terminals: z.array(z.unknown()).max(LOCAL_TERMINAL_LIST_MAX) });
const ListedTerminalSchema = z.object({
  address: z.string().regex(LOCAL_TERMINAL_ID_PATTERN),
  state: z.string().max(32),
  // Titles and status come from the program in the terminal: anything goes in,
  // only a bounded printable title and a known state come out.
  title: z.string().nullable().optional().catch(null),
  name: z.string().nullable().optional().catch(null),
  status: z.object({ state: z.string().max(32) }).nullable().optional().catch(null),
  labels: z.record(z.string(), z.string()).nullable().optional().catch(null),
});
/** The label a rename sets; it wins over the program's own title. */
export const TERMINAL_TITLE_LABEL = "matrix.title";
const PutResultSchema = z.object({ path: z.string().min(1).max(4096) });
// Fixed command lines for the agents the window can start. Codex runs without
// its shared daemon, which would otherwise run later sessions as the first one.
const AGENT_COMMANDS: Record<LocalTerminalAgent, string> = {
  claude: "claude",
  codex: "codex --no-daemon",
  opencode: "opencode",
  pi: "pi",
};
// Runs the agent in the user's login shell, then leaves that shell open, as
// Herdr does. `$1` is the shell and `$2` the fixed agent command.
const AGENT_LAUNCHER = '"$1" -lc "$2"; exec "$1" -l';

export class LocalTerminalFolderError extends Error {
  constructor() { super("terminal folder is not a folder in your home"); this.name = "LocalTerminalFolderError"; }
}
const RanSchema = z.object({ address: z.string().regex(LOCAL_TERMINAL_ID_PATTERN) });
// Control characters and bidirectional overrides can disguise a title.
const UNSAFE_TITLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// A dial fails this way only when no core is listening on the socket.
const NO_CORE_CODES = new Set(["ENOENT", "ECONNREFUSED"]);

export type LocalTerminalHostStatus = "ready" | "not-installed" | "unavailable" | "version-mismatch";

export class LocalRuntimeMissingError extends Error {
  constructor() { super("local terminal runtime is not installed"); this.name = "LocalRuntimeMissingError"; }
}

export function safeTerminalTitle(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const title = candidate?.replace(UNSAFE_TITLE_CHARS, "").trim().slice(0, MAX_TITLE_CHARS);
    if (title) return title;
  }
  return "Terminal";
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

interface Attachment {
  stream: HcStream | null;
  /**
   * One entry per output event sent to the window and not yet acknowledged:
   * the credit to return for it, or null for a part of a larger chunk. The
   * core stops sending when its window is spent, which bounds this queue.
   */
  unacknowledged: Array<(() => void) | null>;
}

export function createLocalTerminalHost(options: LocalTerminalHostOptions, sink: {
  output(attachId: number, data: string): void;
  closed(attachId: number): void;
}) {
  const now = options.now ?? Date.now;
  const socketPath = join(options.runtimeDir, "herdr-core", `${SESSION}.sock`);
  // Bounded by MAX_ATTACHMENTS; cleared on disconnect and dispose.
  const attachments = new Map<number, Attachment>();
  const starts: number[] = [];
  // Start times of recent creations: at most MAX_CREATES_PER_WINDOW entries.
  let creates: number[] = [];
  let connection: HcConnection | null = null;
  let connecting: Promise<HcConnection> | null = null;
  let status: LocalTerminalHostStatus = "unavailable";
  let nextAttachId = 1;
  // Changes whenever every attachment is released (the window closed,
  // reloaded or crashed). An attach that started before that belongs to a
  // window that is gone and must not complete.
  let releaseEpoch = 0;
  let disposed = false;
  // Creations run one at a time, so the rate limit counts them in order.
  let creation: Promise<unknown> = Promise.resolve();

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
          const open = [...attachments.keys()];
          attachments.clear();
          for (const attachId of open) sink.closed(attachId);
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

  async function live(core: HcConnection): Promise<LocalTerminal[]> {
    const listed = ListedSchema.parse(await core.call("terminal.list", {}));
    const terminals: LocalTerminal[] = [];
    for (const entry of listed.terminals) {
      const terminal = ListedTerminalSchema.safeParse(entry);
      if (!terminal.success || terminal.data.state !== "live") continue;
      const state = LocalTerminalStatusSchema.safeParse(terminal.data.status?.state);
      terminals.push({
        id: terminal.data.address,
        title: safeTerminalTitle(terminal.data.labels?.[TERMINAL_TITLE_LABEL], terminal.data.title, terminal.data.name),
        status: state.success ? state.data : null,
      });
    }
    return terminals;
  }

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

  async function run(
    size: { cols: number; rows: number },
    launch: { agent?: LocalTerminalAgent; folder?: string },
  ): Promise<string | null> {
    const cwd = launch.folder ? await folderUnderHome(launch.folder) : options.home;
    const core = await ensure();
    const time = now();
    creates = creates.filter((started) => time - started < CREATE_WINDOW_MS);
    if (creates.length >= MAX_CREATES_PER_WINDOW) return null;
    creates.push(time);
    const unset = CORE_ONLY_ENV.flatMap((name) => ["-u", name]);
    const ran = RanSchema.parse(await core.call("terminal.run", {
      argv: launch.agent
        ? ["/usr/bin/env", ...unset, "/bin/sh", "-c", AGENT_LAUNCHER, "matrix-agent", options.shell, AGENT_COMMANDS[launch.agent]]
        : ["/usr/bin/env", ...unset, options.shell, "-l"],
      cwd,
      ...(launch.agent ? { labels: { "matrix.agent": launch.agent } } : {}),
      env: { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "MatrixOS" },
      size,
      no_parent: true,
      no_notify: true,
      wait: false,
    }));
    return ran.address;
  }

  function release(attachId: number): boolean {
    const attachment = attachments.get(attachId);
    if (!attachment) return false;
    attachments.delete(attachId);
    attachment.stream?.close();
    return true;
  }

  return {
    status: (): LocalTerminalHostStatus => status,

    /** Every live terminal the core reports. */
    async list(): Promise<LocalTerminal[]> {
      return live(await ensure());
    },

    /**
     * Starts the user's login shell, or one of the known agents in it, at home or
     * in a folder under home. Returns null when too many were started just now.
     */
    create(
      size: { cols: number; rows: number },
      launch: { agent?: LocalTerminalAgent; folder?: string } = {},
    ): Promise<string | null> {
      const next = creation.then(() => run(size, launch));
      // The chain itself never rejects; each caller still sees its own outcome.
      creation = next.catch(() => undefined);
      return next;
    },

    async kill(id: string): Promise<void> {
      const core = await ensure();
      await core.call("terminal.kill", { terminal: id });
    },

    /** Names a terminal for every client of this core: a label, so the program's own title stays. */
    async rename(id: string, name: string): Promise<void> {
      const core = await ensure();
      await core.call("terminal.label", { terminal: id, labels: { [TERMINAL_TITLE_LABEL]: safeTerminalTitle(name) } });
    },

    /** Writes a pasted file beside the terminal, on its machine; returns where it landed. */
    async put(id: string, name: string, dataBase64: string): Promise<string> {
      const core = await ensure();
      return PutResultSchema.parse(await core.call("terminal.put", { terminal: id, name, data: dataBase64 })).path;
    },

    async attach(id: string, size: { cols: number; rows: number }): Promise<number> {
      const startedIn = releaseEpoch;
      const core = await ensure();
      if (releaseEpoch !== startedIn) throw new Error("local terminal attachment ended");
      if (attachments.size >= MAX_ATTACHMENTS) throw new Error("too many local terminal attachments");
      const attachId = nextAttachId++;
      const decoder = new TextDecoder("utf-8");
      // Registered before the core answers: output and even the end of the
      // terminal can arrive in the same read as the answer.
      const attachment: Attachment = { stream: null, unacknowledged: [] };
      attachments.set(attachId, attachment);
      try {
        attachment.stream = await core.attach({ terminal: id, ...size }, {
          onData: (chunk, consumed) => {
            const text = decoder.decode(chunk, { stream: true });
            if (text.length === 0) { consumed(); return; }
            for (let offset = 0; offset < text.length; offset += LOCAL_TERMINAL_MAX_OUTPUT_CHARS) {
              const last = offset + LOCAL_TERMINAL_MAX_OUTPUT_CHARS >= text.length;
              attachment.unacknowledged.push(last ? consumed : null);
              sink.output(attachId, text.slice(offset, offset + LOCAL_TERMINAL_MAX_OUTPUT_CHARS));
            }
          },
          onClose: () => { if (attachments.delete(attachId)) sink.closed(attachId); },
        });
      } catch (error: unknown) {
        attachments.delete(attachId);
        throw error;
      }
      // Released while the core was answering (window closed, or the terminal ended).
      if (attachments.get(attachId) !== attachment) {
        attachment.stream.close();
        throw new Error("local terminal attachment ended");
      }
      return attachId;
    },

    /** The window took `count` output events; their credit goes back to the core. */
    acknowledge(attachId: number, count: number): boolean {
      const attachment = attachments.get(attachId);
      if (!attachment) return false;
      for (const credit of attachment.unacknowledged.splice(0, count)) credit?.();
      return true;
    },

    /** False when the attachment is gone, so the caller can stop typing into nothing. */
    input(attachId: number, data: string, binary: boolean): boolean {
      const stream = attachments.get(attachId)?.stream;
      stream?.write(Buffer.from(data, binary ? "latin1" : "utf8"));
      return stream != null;
    },

    resize(attachId: number, size: { cols: number; rows: number }): boolean {
      const stream = attachments.get(attachId)?.stream;
      stream?.resize(size.cols, size.rows);
      return stream != null;
    },

    detach(attachId: number): void {
      release(attachId);
    },

    /**
     * Releases every attachment without telling the window: it is closing,
     * reloading or gone, and can no longer detach for itself.
     */
    detachAll(): void {
      releaseEpoch += 1;
      for (const attachId of [...attachments.keys()]) release(attachId);
    },

    /** Detaches from the core. The core and its terminals keep running. */
    dispose(): void {
      disposed = true;
      releaseEpoch += 1;
      attachments.clear();
      connection?.close();
      connection = null;
    },
  };
}

export type LocalTerminalHost = ReturnType<typeof createLocalTerminalHost>;
