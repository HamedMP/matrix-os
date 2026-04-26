import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import type { AgentLaunchSpec } from "./agent-launcher.js";

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

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
const ZELLIJ_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

const defaultRunCommand: CommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
};

function sessionName(sessionId: string): string {
  const parsed = SessionIdSchema.parse(sessionId);
  return `matrix-${parsed}`;
}

function kdlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
    `    pane cwd ${kdlString(input.launch.cwd)} command ${kdlString(input.launch.command)} {`,
    argsLine.trimEnd(),
    "    }",
    "  }",
    "}",
    "",
  ].filter((line) => line.length > 0).join("\n");
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
}) {
  const homePath = resolve(options.homePath);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const layoutDir = join(homePath, "system", "zellij", "layouts");

  return {
    async generateLayout(input: {
      sessionId: string;
      launch: AgentLaunchSpec;
    }): Promise<ZellijLayoutResult> {
      const name = sessionName(input.sessionId);
      const layoutPath = join(layoutDir, `${input.sessionId}.kdl`);
      await mkdir(layoutDir, { recursive: true });
      await atomicWriteText(layoutPath, renderLayout({ sessionName: name, launch: input.launch }));
      return { sessionName: name, layoutPath };
    },

    async start(input: {
      sessionId: string;
      launch: AgentLaunchSpec;
    }): Promise<ZellijStartResult> {
      const layout = await this.generateLayout(input);
      await runCommand("zellij", ["--session", layout.sessionName, "--layout", layout.layoutPath], {
        cwd: input.launch.cwd,
        timeout: ZELLIJ_TIMEOUT_MS,
      });
      return { ok: true, status: "running", ...layout };
    },

    attachCommand(sessionId: string): string[] {
      return ["zellij", "attach", sessionName(sessionId)];
    },

    observeCommand(sessionId: string): string[] {
      return ["zellij", "attach", sessionName(sessionId), "--index", "0"];
    },

    async kill(sessionId: string): Promise<{ ok: true }> {
      await runCommand("zellij", ["kill-session", sessionName(sessionId)], {
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
