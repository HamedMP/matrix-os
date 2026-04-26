import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod/v4";

export const SupportedAgentSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export type SupportedAgent = z.infer<typeof SupportedAgentSchema>;

export type AgentAuthState = "unknown" | "ok" | "required" | "error";

export interface AgentStatus {
  id: SupportedAgent;
  command: string;
  displayName: string;
  installed: boolean;
  authState: AgentAuthState;
  version?: string;
  errorCode: string | null;
}

export interface AgentLaunchSandbox {
  enabled: boolean;
  writableRoots?: string[];
  adminOverride?: boolean;
}

export interface AgentLaunchInput {
  agent: SupportedAgent;
  cwd: string;
  prompt?: string;
  sandbox?: AgentLaunchSandbox;
}

export interface AgentLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 5_000;

const AGENTS: Record<SupportedAgent, { command: string; displayName: string }> = {
  claude: { command: "claude", displayName: "Claude" },
  codex: { command: "codex", displayName: "Codex" },
  opencode: { command: "opencode", displayName: "OpenCode" },
  pi: { command: "pi", displayName: "Pi" },
};

const defaultRunCommand: CommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
};

function firstLine(value: string): string | undefined {
  const line = value.split("\n").map((part) => part.trim()).find(Boolean);
  return line || undefined;
}

function promptArgs(prompt?: string): string[] {
  return prompt && prompt.length > 0 ? [prompt] : [];
}

function codexSandboxArgs(sandbox?: AgentLaunchSandbox): string[] {
  if (!sandbox) {
    throw new Error("Codex sandbox preflight is required");
  }
  if (!sandbox.enabled) {
    if (sandbox.adminOverride === true) {
      return ["--dangerously-bypass-sandbox"];
    }
    throw new Error("Codex sandbox preflight is required");
  }
  const args = ["--sandbox", "workspace-write"];
  for (const root of sandbox.writableRoots ?? []) {
    args.push("--writable-root", root);
  }
  return args;
}

export function buildAgentLaunch(input: AgentLaunchInput): AgentLaunchSpec {
  const parsed = SupportedAgentSchema.parse(input.agent);
  const command = AGENTS[parsed].command;
  switch (parsed) {
    case "claude":
      return { command, args: promptArgs(input.prompt), cwd: input.cwd, env: {} };
    case "codex":
      return {
        command,
        args: [...codexSandboxArgs(input.sandbox), ...promptArgs(input.prompt)],
        cwd: input.cwd,
        env: {},
      };
    case "opencode":
      return { command, args: ["run", ...promptArgs(input.prompt)], cwd: input.cwd, env: {} };
    case "pi":
      return { command, args: promptArgs(input.prompt), cwd: input.cwd, env: {} };
  }
}

export function createAgentLauncher(options: {
  runCommand?: CommandRunner;
  cwd?: string;
} = {}) {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const cwd = options.cwd ?? process.cwd();

  return {
    async detectAgents(): Promise<{ agents: AgentStatus[] }> {
      const agents: AgentStatus[] = [];
      for (const id of SupportedAgentSchema.options) {
        const config = AGENTS[id];
        let version: string | undefined;
        try {
          const result = await runCommand(config.command, ["--version"], {
            cwd,
            timeout: DETECT_TIMEOUT_MS,
          });
          version = firstLine(result.stdout) ?? firstLine(result.stderr);
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.warn(`[agent-launcher] ${config.command} is unavailable:`, err.message);
          }
          agents.push({
            id,
            command: config.command,
            displayName: config.displayName,
            installed: false,
            authState: "unknown",
            errorCode: "agent_missing",
          });
          continue;
        }

        try {
          await runCommand(config.command, ["auth", "status"], {
            cwd,
            timeout: DETECT_TIMEOUT_MS,
          });
          agents.push({
            id,
            command: config.command,
            displayName: config.displayName,
            installed: true,
            authState: "ok",
            version,
            errorCode: null,
          });
        } catch (err: unknown) {
          if (err instanceof Error) {
            console.warn(`[agent-launcher] ${config.command} auth is unavailable:`, err.message);
          }
          agents.push({
            id,
            command: config.command,
            displayName: config.displayName,
            installed: true,
            authState: "required",
            version,
            errorCode: "agent_auth_required",
          });
        }
      }
      return { agents };
    },

    buildLaunch(input: AgentLaunchInput): AgentLaunchSpec {
      return buildAgentLaunch(input);
    },
  };
}
