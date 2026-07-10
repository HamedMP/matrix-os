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
  mode?: "read-only" | "workspace-write" | "danger-full-access";
  writableRoots?: string[];
  denyWriteRoots?: string[];
  adminOverride?: boolean;
}

export interface AgentLaunchInput {
  agent: SupportedAgent;
  cwd: string;
  prompt?: string;
  mode?: "default" | "plan" | "review" | "full_access";
  sandbox?: AgentLaunchSandbox;
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
  runtimeHome?: string;
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
  options: { cwd: string; timeout: number; env?: Record<string, string> },
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
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  return { stdout, stderr };
};

function firstLine(value: string): string | undefined {
  const line = value.split("\n").map((part) => part.trim()).find(Boolean);
  return line || undefined;
}

function promptArgs(prompt?: string): string[] {
  if (!prompt || prompt.length === 0) return [];
  return ["--", prompt];
}

function agentRuntimeEnv(runtimeHome?: string): Record<string, string> {
  if (!runtimeHome) return {};
  return {
    HOME: runtimeHome,
    MATRIX_HOME: runtimeHome,
  };
}

function codexSandboxArgs(sandbox?: AgentLaunchSandbox): string[] {
  if (!sandbox) {
    throw new Error("Codex sandbox preflight is required");
  }
  if (!sandbox.enabled) {
    if (sandbox.adminOverride === true) {
      return ["--dangerously-bypass-approvals-and-sandbox"];
    }
    throw new Error("Codex sandbox preflight is required");
  }
  const mode = sandbox.mode ?? "workspace-write";
  const args = ["--sandbox", mode];
  if (mode === "workspace-write") {
    for (const root of sandbox.writableRoots ?? []) {
      args.push("--add-dir", root);
    }
  }
  return args;
}

const ClaudePermissionModeSchema = z.enum(["default", "dontAsk", "plan", "bypassPermissions"]);
const ClaudeEditPermissionRuleSchema = z.string()
  .trim()
  .min(1)
  .max(4128)
  .regex(/^Edit\(\/\/[^)\r\n]+\/\*\*\)$/);
const ClaudeLaunchSettingsSchema = z.object({
  permissions: z.object({
    allow: z.array(ClaudeEditPermissionRuleSchema).max(20).optional(),
    deny: z.array(z.enum(["Edit", "Write", "NotebookEdit"])).max(3).optional(),
  }).strict().optional(),
  sandbox: z.object({
    enabled: z.boolean(),
    failIfUnavailable: z.literal(true).optional(),
    autoAllowBashIfSandboxed: z.boolean().optional(),
    allowUnsandboxedCommands: z.literal(false).optional(),
    filesystem: z.object({
      allowWrite: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
      denyWrite: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
    }).strict().optional(),
  }).strict(),
}).strict();

const ClaudeWritableRootSchema = z.string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^\/[^*?[\]{}()\\\u0000\r\n]*$/);

function claudeEditPermissionRule(root: string): string {
  const absoluteRoot = ClaudeWritableRootSchema.parse(root).replace(/\/+$/, "");
  if (!absoluteRoot) throw new Error("Claude writable root is invalid");
  return ClaudeEditPermissionRuleSchema.parse(`Edit(/${absoluteRoot}/**)`);
}

function claudePermissionMode(input: AgentLaunchInput): z.infer<typeof ClaudePermissionModeSchema> {
  if (input.mode === "plan" || input.mode === "review") return "plan";
  if (input.approvalPolicy === "on-failure") {
    throw new Error("Claude approval policy is unavailable");
  }
  if (input.approvalPolicy !== "never") return "default";
  if (input.sandbox?.mode === "danger-full-access" || input.sandbox?.enabled === false) {
    return "bypassPermissions";
  }
  return "dontAsk";
}

function claudeLaunchSettings(input: AgentLaunchInput): z.infer<typeof ClaudeLaunchSettingsSchema> {
  const sandbox = input.sandbox;
  if (!sandbox) {
    throw new Error("Claude sandbox preflight is required");
  }
  const readOnlyMode = input.mode === "plan" || input.mode === "review";
  if (!readOnlyMode && (!sandbox.enabled || sandbox.mode === "danger-full-access")) {
    return ClaudeLaunchSettingsSchema.parse({ sandbox: { enabled: false } });
  }

  const mode = readOnlyMode
    ? "read-only"
    : sandbox.mode ?? "workspace-write";
  const noPrompt = input.approvalPolicy === "never" && input.mode !== "plan" && input.mode !== "review";
  if (mode === "read-only") {
    return ClaudeLaunchSettingsSchema.parse({
      permissions: { deny: ["Edit", "Write", "NotebookEdit"] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: sandbox.denyWriteRoots ?? [input.cwd] },
      },
    });
  }

  return ClaudeLaunchSettingsSchema.parse({
    permissions: noPrompt
      ? {
          allow: (sandbox.writableRoots ?? []).map(claudeEditPermissionRule),
          deny: ["Write", "NotebookEdit"],
        }
      : { deny: ["Edit", "Write", "NotebookEdit"] },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: sandbox.writableRoots ?? [] },
    },
  });
}

function claudeLaunchArgs(input: AgentLaunchInput): string[] {
  const permissionMode = ClaudePermissionModeSchema.parse(claudePermissionMode(input));
  const settings = JSON.stringify(claudeLaunchSettings(input));
  return [
    "--setting-sources",
    "",
    "--settings",
    settings,
    "--permission-mode",
    permissionMode,
    "--strict-mcp-config",
    "--no-chrome",
    ...(input.prompt ? ["--print"] : []),
    ...promptArgs(input.prompt),
  ];
}

function authStatusArgs(agent: SupportedAgent): string[] {
  return agent === "codex" ? ["login", "status"] : ["auth", "status"];
}

function codexModeArgs(mode?: AgentLaunchInput["mode"]): string[] {
  return mode === "review" ? ["review"] : [];
}

function codexPrompt(prompt: string | undefined, mode?: AgentLaunchInput["mode"]): string | undefined {
  if (mode !== "plan") return prompt;
  const planPrefix = "Plan the work first. Do not modify files until the plan is clear.";
  return prompt ? `${planPrefix}\n\n${prompt}` : planPrefix;
}

export function buildAgentLaunch(input: AgentLaunchInput): AgentLaunchSpec {
  const parsed = SupportedAgentSchema.parse(input.agent);
  const command = AGENTS[parsed].command;
  const env = agentRuntimeEnv(input.runtimeHome);
  switch (parsed) {
    case "claude":
      return { command, args: claudeLaunchArgs(input), cwd: input.cwd, env };
    case "codex":
      return {
        command,
        args: [
          "--ask-for-approval",
          input.approvalPolicy ?? "never",
          "exec",
          "--skip-git-repo-check",
          ...codexSandboxArgs(input.sandbox),
          ...codexModeArgs(input.mode),
          ...promptArgs(codexPrompt(input.prompt, input.mode)),
        ],
        cwd: input.cwd,
        env,
      };
    case "opencode":
      return { command, args: ["run", ...promptArgs(input.prompt)], cwd: input.cwd, env };
    case "pi":
      return { command, args: promptArgs(input.prompt), cwd: input.cwd, env };
  }
}

export function createAgentLauncher(options: {
  runCommand?: CommandRunner;
  cwd?: string;
  runtimeHome?: string;
} = {}) {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const cwd = options.cwd ?? process.cwd();
  const detectEnv = agentRuntimeEnv(options.runtimeHome);

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
            env: detectEnv,
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
          await runCommand(config.command, authStatusArgs(id), {
            cwd,
            timeout: DETECT_TIMEOUT_MS,
            env: detectEnv,
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
      return buildAgentLaunch({ ...input, runtimeHome: input.runtimeHome ?? options.runtimeHome });
    },
  };
}
