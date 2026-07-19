import {
  execFile as nodeExecFile,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shellError, type ShellSafeError } from "./errors.js";
import {
  MATRIX_TERMINAL_BASHRC,
  MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT,
  MATRIX_ZELLIJ_LAYOUT,
  matrixTerminalShellScript,
  matrixZellijConfigPaths,
  renderMatrixZellijConfig,
  type MatrixZellijShellThemeId,
  type MatrixZellijConfigPaths,
} from "./zellij-config.js";
import { applyTerminalTruecolorEnv } from "../terminal-env.js";

type ExecFile = typeof nodeExecFile;
type Disposable = { dispose(): void };
type PtyExitEvent = { exitCode: number; signal?: number };
export interface ShellAttachProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: PtyExitEvent) => void): Disposable;
  /** node-pty flow control; used by WS backpressure to pause a slow client. */
  pause?(): void;
  resume?(): void;
}
type PtySpawn = (
  command: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => ShellAttachProcess;

const esmRequire = createRequire(import.meta.url);

function defaultPtySpawn(): PtySpawn {
  return (esmRequire("node-pty") as { spawn: PtySpawn }).spawn;
}

export interface ZellijFailureDiagnostic {
  binary: "zellij";
  kind: "binary_not_found" | "timeout" | "process_failed";
  stderr?: string;
  errorCode?: string;
  exitCode?: number;
  signal?: string;
}

export interface ZellijAdapterDeps {
  execFile?: ExecFile;
  spawn?: unknown;
  spawnPty?: PtySpawn;
  timeoutMs?: number;
  startupDelayMs?: number;
  retainedPtyTtlMs?: number;
  maxRetainedPtys?: number;
  nowMs?: () => number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homePath?: string;
}

export interface CreateSessionOptions {
  name: string;
  cwd?: string;
  layout?: string;
  cmd?: string;
}

export interface AttachOptions {
  signal?: AbortSignal;
  size?: { cols: number; rows: number };
}

export interface ZellijAdapter {
  health(): Promise<{ ok: boolean; code: "ok" | "zellij_failed" }>;
  listSessions(): Promise<string[]>;
  createSession(options: CreateSessionOptions): Promise<void>;
  deleteSession(name: string, options?: { force?: boolean }): Promise<void>;
  renameSession(name: string, nextName: string): Promise<void>;
  validateLayout(path: string): Promise<void>;
  attachSession(name: string, options?: AttachOptions): ShellAttachProcess;
  sendInput(name: string, data: string): Promise<void>;
  listTabs(name: string): Promise<unknown[]>;
  createTab(name: string, input: { name?: string; cwd?: string; cmd?: string }): Promise<unknown>;
  switchTab(name: string, tab: number): Promise<unknown>;
  closeTab(name: string, tab: number): Promise<unknown>;
  splitPane(name: string, input: { direction: "right" | "down"; cwd?: string; cmd?: string }): Promise<unknown>;
  closePane(name: string, pane: string): Promise<unknown>;
  applyLayout(name: string, layout: string): Promise<unknown>;
  dumpLayout(name: string): Promise<unknown>;
  setShellTheme(themeId: MatrixZellijShellThemeId): Promise<void>;
}

const SAFE_ATTACH_ENV_KEYS = new Set([
  "COLORTERM",
  "DISPLAY",
  "HOME",
  "LANG",
  "LOGNAME",
  "MATRIX_HOME",
  "MATRIX_APP_DIR",
  "MATRIX_INSTALL_TOOL_PACK",
  "MATRIX_NODE_PREFIX",
  "MATRIX_RUNTIME_DIR",
  "MATRIX_RUNTIME_HOME",
  "MATRIX_RUNTIME_USER",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]);

const ZELLIJ_CONTEXT_ENV_KEYS = new Set([
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);
const DEFAULT_STARTUP_DELAY_MS = 500;
const DEFAULT_RETAINED_PTY_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MAX_RETAINED_PTYS = 128;
type RetainedCreatePty = {
  process: ShellAttachProcess;
  startedAtMs: number;
  exitDisposable: Disposable | null;
  tempLayoutDir?: string;
};

function attachEnv(
  source: NodeJS.ProcessEnv = process.env,
  configPaths: MatrixZellijConfigPaths | null = null,
  homePath?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (ZELLIJ_CONTEXT_ENV_KEYS.has(key)) continue;
    if (SAFE_ATTACH_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("ZELLIJ_")) {
      env[key] = value;
    }
  }
  env.LANG = env.LANG || "en_US.UTF-8";
  if (homePath) {
    env.HOME = homePath;
    env.MATRIX_HOME = homePath;
  }
  if (configPaths) {
    env.ZELLIJ_CONFIG_DIR = configPaths.dir;
    env.ZELLIJ_CONFIG_FILE = configPaths.file;
  }
  return applyTerminalTruecolorEnv(env);
}

export function sanitizeZellijError(stderr: string): string {
  return stderr
    .replace(/\/(?:home|tmp|var|app|workspace|Users)\/[^\s)]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s)]+/g, "[path]")
    .trim();
}

export function classifyZellijFailure(err: unknown, stderr: string): ZellijFailureDiagnostic {
  const safeStderr = sanitizeZellijError(stderr);
  const diagnostic: ZellijFailureDiagnostic = {
    binary: "zellij",
    kind: "process_failed",
  };

  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException & { code?: string | number | null }).code;
    const signal = (err as { signal?: unknown }).signal;
    const killed = (err as { killed?: unknown }).killed === true;
    if (code === "ENOENT") {
      diagnostic.kind = "binary_not_found";
    } else if (code === "ETIMEDOUT" || (code == null && killed && signal === "SIGTERM")) {
      diagnostic.kind = "timeout";
    }
    if (typeof code === "number") {
      diagnostic.exitCode = code;
    } else if (typeof code === "string") {
      diagnostic.errorCode = code;
    }
    if (typeof signal === "string") {
      diagnostic.signal = signal;
    }
  }
  if (safeStderr) {
    diagnostic.stderr = safeStderr;
  }
  return diagnostic;
}

function safeZellijError(
  err: unknown,
  stderr = "",
): ShellSafeError & {
  cause?: unknown;
  stderr?: string;
  diagnostic?: ZellijFailureDiagnostic;
} {
  const safe = shellError("zellij_failed", "Shell operation failed", 500) as ShellSafeError & {
    cause?: unknown;
    stderr?: string;
    diagnostic?: ZellijFailureDiagnostic;
  };
  safe.cause = err;
  safe.stderr = sanitizeZellijError(stderr);
  safe.diagnostic = classifyZellijFailure(err, stderr);
  return safe;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isNoActiveSessionsFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const stderr = (err as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && /no active zellij sessions found/i.test(stderr);
}

async function cleanupTempLayoutDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err: unknown) {
    console.warn("[shell] failed to remove zellij temp layout:", err instanceof Error ? err.message : String(err));
  }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, { flag: "wx", mode: 0o600 });
    await rename(tmpPath, path);
  } catch (err: unknown) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

export function createZellijAdapter(deps: ZellijAdapterDeps = {}): ZellijAdapter {
  const execFile = deps.execFile ?? nodeExecFile;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const startupDelayMs = deps.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
  const retainedPtyTtlMs = deps.retainedPtyTtlMs ?? DEFAULT_RETAINED_PTY_TTL_MS;
  const maxRetainedPtys = deps.maxRetainedPtys ?? DEFAULT_MAX_RETAINED_PTYS;
  const nowMs = deps.nowMs ?? Date.now;
  const cwd = deps.cwd ?? process.cwd();
  const spawnPty = deps.spawnPty ?? defaultPtySpawn();
  const retainedCreatePtys = new Map<string, RetainedCreatePty>();
  const zellijConfigPaths = deps.homePath ? matrixZellijConfigPaths(deps.homePath) : null;
  let ensureConfigPromise: Promise<void> | null = null;
  let shellThemeId: MatrixZellijShellThemeId = "dark";

  async function ensureMatrixZellijConfig(): Promise<void> {
    if (!zellijConfigPaths) {
      return;
    }
    if (!ensureConfigPromise) {
      ensureConfigPromise = (async () => {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(zellijConfigPaths.layoutDir, { recursive: true });
        await atomicWriteText(
          zellijConfigPaths.shellFile,
          matrixTerminalShellScript(zellijConfigPaths.bashrcFile, zellijConfigPaths.promptLabelFile),
        );
        await chmod(zellijConfigPaths.shellFile, 0o700);
        await atomicWriteText(zellijConfigPaths.bashrcFile, MATRIX_TERMINAL_BASHRC);
        await atomicWriteText(zellijConfigPaths.promptLabelFile, MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT);
        await atomicWriteText(zellijConfigPaths.file, renderMatrixZellijConfig(zellijConfigPaths, shellThemeId));
        await atomicWriteText(zellijConfigPaths.layoutFile, MATRIX_ZELLIJ_LAYOUT);
      })().catch((err: unknown) => {
        ensureConfigPromise = null;
        throw err;
      });
    }
    await ensureConfigPromise;
  }

  function releaseRetainedCreatePty(name: string, options: { kill?: boolean } = {}): void {
    const retained = retainedCreatePtys.get(name);
    if (!retained) {
      return;
    }
    retainedCreatePtys.delete(name);
    retained.exitDisposable?.dispose();
    retained.exitDisposable = null;
    if (retained.tempLayoutDir) {
      void cleanupTempLayoutDir(retained.tempLayoutDir);
    }
    if (options.kill) {
      retained.process.kill();
    }
  }

  function sweepRetainedCreatePtys(): void {
    const cutoff = nowMs() - retainedPtyTtlMs;
    for (const [name, retained] of retainedCreatePtys) {
      if (retained.startedAtMs > cutoff) {
        continue;
      }
      releaseRetainedCreatePty(name, { kill: true });
    }
  }

  function evictRetainedCreatePtyIfNeeded(nextName: string): void {
    if (retainedCreatePtys.has(nextName) || retainedCreatePtys.size < maxRetainedPtys) {
      return;
    }
    const oldest = retainedCreatePtys.keys().next().value as string | undefined;
    if (oldest) {
      releaseRetainedCreatePty(oldest, { kill: true });
    }
  }

  async function run(args: string[], timeout = timeoutMs, runCwd?: string): Promise<string> {
    await ensureMatrixZellijConfig();
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const child = execFile(
        "zellij",
        args,
        {
          timeout,
          signal: controller.signal,
          cwd: runCwd,
          env: attachEnv(deps.env, zellijConfigPaths, deps.homePath),
        },
        (err, stdout, stderr) => {
          if (err) {
            reject(safeZellijError(err, typeof stderr === "string" ? stderr : String(stderr ?? "")));
            return;
          }
          resolve(String(stdout));
        },
      );
      child.once?.("error", (err) => reject(err));
    });
  }

  function attachProcess(name: string, options: AttachOptions = {}): ShellAttachProcess {
    const pty = spawnPty("zellij", ["attach", name], {
      name: "xterm-256color",
      cols: options.size?.cols ?? 120,
      rows: options.size?.rows ?? 40,
      cwd,
      env: attachEnv(deps.env, zellijConfigPaths, deps.homePath),
    });
    const abort = () => {
      pty.kill();
    };
    const exitDisposable = pty.onExit(() => {
      options.signal?.removeEventListener("abort", abort);
      exitDisposable.dispose();
    });
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }
    return pty;
  }

  return {
    async health() {
      try {
        await run(["--version"]);
        return { ok: true, code: "ok" };
      } catch (err: unknown) {
        const diagnostic = err instanceof Error && "diagnostic" in err
          ? (err as { diagnostic?: unknown }).diagnostic
          : classifyZellijFailure(err, "");
        console.warn("[shell] backend health failed:", { code: "zellij_failed", diagnostic });
        return { ok: false, code: "zellij_failed" };
      }
    },
    async listSessions() {
      let stdout: string;
      try {
        stdout = await run(["list-sessions", "--no-formatting"]);
      } catch (err) {
        if (isNoActiveSessionsFailure(err)) {
          return [];
        }
        throw err;
      }
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean);
    },
    async createSession(options) {
      await ensureMatrixZellijConfig();
      sweepRetainedCreatePtys();
      evictRetainedCreatePtyIfNeeded(options.name);
      releaseRetainedCreatePty(options.name, { kill: true });

      const args = ["--session", options.name];
      let tempLayoutDir: string | undefined;
      let retainedRegistered = false;
      try {
        if (options.cmd) {
          tempLayoutDir = await mkdtemp(join(tmpdir(), "matrix-zellij-layout-"));
          const layoutPath = join(tempLayoutDir, "layout.kdl");
          await writeFile(layoutPath, initialCommandLayout(options.cmd, options.cwd, zellijConfigPaths?.shellFile), { mode: 0o600 });
          args.push("--new-session-with-layout", layoutPath);
        } else if (options.layout) {
          args.push("--layout", options.layout);
        } else if (zellijConfigPaths) {
          args.push("--new-session-with-layout", zellijConfigPaths.layoutFile);
        }

        let pty: ShellAttachProcess;
        pty = spawnPty("zellij", args, {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          cwd: options.cwd ?? cwd,
          env: attachEnv(deps.env, zellijConfigPaths, deps.homePath),
        });

        const startup = { exited: null as PtyExitEvent | null };
        const retained: RetainedCreatePty = {
          process: pty,
          startedAtMs: nowMs(),
          exitDisposable: null,
          ...(tempLayoutDir ? { tempLayoutDir } : {}),
        };
        retainedCreatePtys.set(options.name, retained);
        retainedRegistered = true;
        const exitDisposable = pty.onExit((event) => {
          startup.exited = event;
          releaseRetainedCreatePty(options.name);
        });
        retained.exitDisposable = exitDisposable;

        await delay(startupDelayMs);
        if (startup.exited) {
          releaseRetainedCreatePty(options.name);
          const err = Object.assign(new Error("zellij exited during startup"), {
            code: startup.exited.exitCode,
            signal: startup.exited.signal == null ? undefined : String(startup.exited.signal),
          });
          throw safeZellijError(err);
        }
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as { code?: unknown }).code === "zellij_failed") {
          throw err;
        }
        throw safeZellijError(err);
      } finally {
        if (tempLayoutDir && !retainedRegistered) {
          await cleanupTempLayoutDir(tempLayoutDir);
        }
      }
    },
    async deleteSession(name, options = {}) {
      releaseRetainedCreatePty(name, { kill: true });
      const args = ["delete-session", name];
      if (options.force) args.push("--force");
      await run(args);
    },
    async renameSession(name, nextName) {
      await run(["--session", name, "action", "rename-session", nextName]);
      const retained = retainedCreatePtys.get(name);
      if (retained) {
        retainedCreatePtys.delete(name);
        retainedCreatePtys.set(nextName, retained);
      }
    },
    async validateLayout(path) {
      await run(["setup", "--check", "--layout", path], 5_000);
    },
    attachSession(name, options = {}) {
      return attachProcess(name, options);
    },
    async sendInput(name, data) {
      await run(["--session", name, "action", "write-chars", "--", data]);
    },
    async listTabs(name) {
      const stdout = await run(["--session", name, "action", "query-tab-names"]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((tab, idx) => ({ idx, name: tab }));
    },
    async createTab(name, input) {
      const args = ["--session", name, "action", "new-tab"];
      if (input.name) args.push("--name", input.name);
      if (input.cwd) args.push("--cwd", input.cwd);
      if (input.cmd) args.push("--", ...splitCommand(input.cmd));
      await run(args);
      return { ok: true };
    },
    async switchTab(name, tab) {
      await run(["--session", name, "action", "go-to-tab", String(tab)]);
      return { ok: true };
    },
    async closeTab(name, tab) {
      await run(["--session", name, "action", "close-tab", String(tab)]);
      return { ok: true };
    },
    async splitPane(name, input) {
      const args = [
        "--session",
        name,
        "action",
        "new-pane",
        input.direction === "right" ? "--right" : "--down",
      ];
      if (input.cwd) args.push("--cwd", input.cwd);
      if (input.cmd) args.push("--", ...splitCommand(input.cmd));
      await run(args);
      return { ok: true };
    },
    async closePane(name, pane) {
      await run(["--session", name, "action", "close-pane", "--pane-id", pane]);
      return { ok: true };
    },
    async applyLayout(name, layout) {
      await run(["--session", name, "action", "new-tab", "--layout", layout]);
      return { ok: true };
    },
    async dumpLayout(name) {
      const kdl = await run(["--session", name, "action", "dump-layout"]);
      return { kdl };
    },
    async setShellTheme(themeId) {
      shellThemeId = themeId;
      ensureConfigPromise = null;
      await ensureMatrixZellijConfig();
    },
  };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote !== null) {
    throw shellError("invalid_command", "Invalid command", 400);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    throw shellError("invalid_command", "Invalid command", 400);
  }
  return parts;
}

function initialCommandLayout(command: string, cwd?: string, shellFile?: string): string {
  const commandArgs = splitCommand(command);
  const [binary, ...args] = shellFile ? [shellFile, ...commandArgs] : commandArgs;
  const paneAttrs = [
    cwd ? `cwd=${kdlString(cwd)}` : null,
    `command=${kdlString(binary)}`,
  ].filter(Boolean).join(" ");
  const argLine = args.length > 0
    ? `      args ${args.map(kdlString).join(" ")}\n`
    : "";
  return `layout {
  tab name="main" {
    pane ${paneAttrs} {
${argLine}    }
  }
}
`;
}

function kdlString(value: string): string {
  return JSON.stringify(value);
}
