import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import type { AgentLaunchSpec } from "./agent-launcher.js";
import { DANGEROUS_CONTROL_CHARS_GLOBAL } from "./prompt-validation.js";
import {
  MATRIX_TERMINAL_BASHRC,
  MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT,
  MATRIX_TERMINAL_ZSHENV,
  MATRIX_TERMINAL_ZSHRC,
  MATRIX_ZELLIJ_LAYOUT,
  matrixTerminalShellScript,
  matrixZellijConfigPaths,
  renderMatrixZellijConfig,
} from "./shell/zellij-config.js";
import { applyTerminalTruecolorEnv } from "./terminal-env.js";

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;
type PtyProcess = Pick<import("node-pty").IPty, "kill" | "onExit">;
type RetainedPty = {
  process: PtyProcess;
  startedAtMs: number;
};
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
) => PtyProcess;

export interface ZellijLayoutResult {
  sessionName: string;
  layoutPath: string;
}

export interface ZellijStartResult extends ZellijLayoutResult {
  ok: true;
  status: "running";
}

export interface ZellijHealth {
  available: boolean;
  status: "ok" | "degraded";
  fallbackReason: string | null;
  version: string | null;
}

const SessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const SessionInputSchema = z.string().min(1).max(64 * 1024);
const ZELLIJ_TIMEOUT_MS = 10_000;
const ZELLIJ_STARTUP_DELAY_MS = 500;
const MAX_RETAINED_ZELLIJ_PTYS = 128;
const RETAINED_PTY_TTL_MS = 4 * 60 * 60 * 1000;
const SAFE_PROCESS_ENV_KEYS = new Set([
  "COLORTERM",
  "DISPLAY",
  "HOME",
  "LANG",
  "LOGNAME",
  "MATRIX_APP_DIR",
  "MATRIX_INSTALL_TOOL_PACK",
  "MATRIX_NODE_PREFIX",
  "MATRIX_RUNTIME_DIR",
  "MATRIX_RUNTIME_HOME",
  "MATRIX_RUNTIME_USER",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
]);

const execFileAsync = promisify(execFile);

const defaultRunCommand: CommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    signal: options.signal,
  });
  return { stdout, stderr };
};

let defaultPtySpawn: PtySpawn | undefined;
async function getDefaultPtySpawn(): Promise<PtySpawn> {
  if (!defaultPtySpawn) {
    const nodePty = await import("node-pty");
    defaultPtySpawn = nodePty.spawn as unknown as PtySpawn;
  }
  return defaultPtySpawn;
}

function sessionName(sessionId: string): string {
  const parsed = SessionIdSchema.parse(sessionId);
  return `matrix-${parsed}`;
}

function kdlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(DANGEROUS_CONTROL_CHARS_GLOBAL, "")
  }"`;
}

function firstLine(value: string): string | null {
  const line = value.split("\n").map((part) => part.trim()).find(Boolean);
  return line ?? null;
}

function renderLayout(input: {
  sessionName: string;
  launch: AgentLaunchSpec;
}): string {
  const args = input.launch.args.map(kdlString).join(" ");
  const argsLine = args.length > 0 ? `      args ${args}\n` : "";
  return [
    `// Matrix OS generated layout for ${input.sessionName}`,
    "layout {",
    "  tab name=\"Agent\" {",
    `    pane cwd=${kdlString(input.launch.cwd)} command=${kdlString(input.launch.command)} {`,
    argsLine.trimEnd(),
    "    }",
    "  }",
    "}",
    "",
  ].filter((line) => line.length > 0).join("\n");
}

function ptyEnv(
  launchEnv: Record<string, string>,
  zellijConfigPaths: { dir: string; file: string } | null = null,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && (SAFE_PROCESS_ENV_KEYS.has(key) || key.startsWith("LC_"))) {
      env[key] = value;
    }
  }
  if (zellijConfigPaths) {
    env.ZELLIJ_CONFIG_DIR = zellijConfigPaths.dir;
    env.ZELLIJ_CONFIG_FILE = zellijConfigPaths.file;
  }
  return applyTerminalTruecolorEnv({
    ...env,
    ...launchEnv,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const { writeFile, rename, rm } = await import("node:fs/promises");
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content, { flag: "wx" });
    await rename(tmpPath, path);
  } catch (err: unknown) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

export function createZellijRuntime(options: {
  homePath: string;
  runCommand?: CommandRunner;
  spawnPty?: PtySpawn;
  startupDelayMs?: number;
  retainedPtyTtlMs?: number;
  nowMs?: () => number;
}) {
  const homePath = resolve(options.homePath);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const spawnPty = options.spawnPty;
  const startupDelayMs = options.startupDelayMs ?? ZELLIJ_STARTUP_DELAY_MS;
  const retainedPtyTtlMs = options.retainedPtyTtlMs ?? RETAINED_PTY_TTL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const zellijConfigPaths = matrixZellijConfigPaths(homePath);
  const layoutDir = zellijConfigPaths.layoutDir;
  const configDir = zellijConfigPaths.dir;
  const configPath = zellijConfigPaths.file;
  const defaultLayoutPath = zellijConfigPaths.layoutFile;
  const retainedPtys = new Map<string, RetainedPty>();
  let ensureConfigPromise: Promise<void> | null = null;

  async function ensureMatrixZellijConfig(): Promise<void> {
    if (!ensureConfigPromise) {
      ensureConfigPromise = (async () => {
        await mkdir(layoutDir, { recursive: true });
        await atomicWriteText(
          zellijConfigPaths.shellFile,
          matrixTerminalShellScript(
            zellijConfigPaths.zshrcFile,
            zellijConfigPaths.bashrcFile,
            zellijConfigPaths.promptLabelFile,
          ),
        );
        await chmod(zellijConfigPaths.shellFile, 0o700);
        await atomicWriteText(zellijConfigPaths.zshenvFile, MATRIX_TERMINAL_ZSHENV);
        await atomicWriteText(zellijConfigPaths.zshrcFile, MATRIX_TERMINAL_ZSHRC);
        await atomicWriteText(zellijConfigPaths.bashrcFile, MATRIX_TERMINAL_BASHRC);
        await atomicWriteText(zellijConfigPaths.promptLabelFile, MATRIX_TERMINAL_PROMPT_LABEL_SCRIPT);
        await atomicWriteText(configPath, renderMatrixZellijConfig(zellijConfigPaths));
        await atomicWriteText(defaultLayoutPath, MATRIX_ZELLIJ_LAYOUT);
      })().catch((err: unknown) => {
        ensureConfigPromise = null;
        throw err;
      });
    }
    await ensureConfigPromise;
  }

  function sweepRetainedPtys(): void {
    const cutoff = nowMs() - retainedPtyTtlMs;
    for (const [name, retained] of retainedPtys) {
      if (retained.startedAtMs > cutoff) continue;
      retained.process.kill();
      retainedPtys.delete(name);
    }
  }

  return {
    async generateLayout(input: {
      sessionId: string;
      launch: AgentLaunchSpec;
    }): Promise<ZellijLayoutResult> {
      const name = sessionName(input.sessionId);
      const layoutPath = join(layoutDir, `${input.sessionId}.kdl`);
      await ensureMatrixZellijConfig();
      await atomicWriteText(layoutPath, renderLayout({ sessionName: name, launch: input.launch }));
      return { sessionName: name, layoutPath };
    },

    async start(input: {
      sessionId: string;
      launch: AgentLaunchSpec;
    }): Promise<ZellijStartResult> {
      const layout = await this.generateLayout(input);
      sweepRetainedPtys();
      if (!retainedPtys.has(layout.sessionName) && retainedPtys.size >= MAX_RETAINED_ZELLIJ_PTYS) {
        throw new Error("zellij_session_limit");
      }
      retainedPtys.get(layout.sessionName)?.process.kill();
      retainedPtys.delete(layout.sessionName);
      const resolvedSpawn = spawnPty ?? await getDefaultPtySpawn();
      const ptyProcess = resolvedSpawn("zellij", ["--session", layout.sessionName, "--new-session-with-layout", layout.layoutPath], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: input.launch.cwd,
        env: ptyEnv(input.launch.env, { dir: configDir, file: configPath }),
      });
      let exited: { exitCode: number; signal?: number } | null = null;
      ptyProcess.onExit((event: { exitCode: number; signal?: number }) => {
        exited = event;
        retainedPtys.delete(layout.sessionName);
      });
      retainedPtys.set(layout.sessionName, { process: ptyProcess, startedAtMs: nowMs() });
      await delay(startupDelayMs);
      if (exited) throw new Error("zellij_start_failed");
      if (!retainedPtys.has(layout.sessionName)) throw new Error("zellij_start_cancelled");
      return { ok: true, status: "running", ...layout };
    },

    attachCommand(sessionId: string): string[] {
      return ["zellij", "attach", sessionName(sessionId)];
    },

    observeCommand(sessionId: string): string[] {
      return ["zellij", "attach", sessionName(sessionId), "--index", "0"];
    },

    async sendInput(sessionId: string, input: string, signal?: AbortSignal): Promise<void> {
      const data = SessionInputSchema.parse(input);
      await runCommand("zellij", [
        "--session",
        sessionName(sessionId),
        "action",
        "write-chars",
        "--",
        data,
      ], {
        cwd: homePath,
        timeout: ZELLIJ_TIMEOUT_MS,
        signal,
      });
    },

    async kill(sessionId: string): Promise<{ ok: true }> {
      const name = sessionName(sessionId);
      const ptyProcess = retainedPtys.get(name);
      retainedPtys.delete(name);
      ptyProcess?.process.kill();
      await runCommand("zellij", ["kill-session", name], {
        cwd: homePath,
        timeout: ZELLIJ_TIMEOUT_MS,
      });
      return { ok: true };
    },

    async health(): Promise<ZellijHealth> {
      try {
        const result = await runCommand("zellij", ["--version"], {
          cwd: homePath,
          timeout: ZELLIJ_TIMEOUT_MS,
        });
        return {
          available: true,
          status: "ok",
          fallbackReason: null,
          version: firstLine(result.stdout) ?? firstLine(result.stderr),
        };
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.warn("[zellij-runtime] zellij unavailable:", err.message);
        }
        return {
          available: false,
          status: "degraded",
          fallbackReason: "zellij_unavailable",
          version: null,
        };
      }
    },
  };
}
