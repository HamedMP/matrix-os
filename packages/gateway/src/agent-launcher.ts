import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";
import { CodexExecutableSchema } from "./coding-agents/codex-executable.js";
import { codexExecContractStatus } from "./coding-agents/codex-version.js";

export const SupportedAgentSchema = z.enum(["claude", "codex", "opencode", "pi"]);
export type SupportedAgent = z.infer<typeof SupportedAgentSchema>;

export type AgentAuthState = "unknown" | "ok" | "required" | "error";
export type AgentInstallState = "installed" | "missing" | "unknown";
export type AgentWorkspaceCompatibility = "compatible" | "unsupported" | "not_applicable" | "unknown";

export interface AgentStatus {
  id: SupportedAgent;
  command: string;
  displayName: string;
  installState: AgentInstallState;
  installed: boolean | null;
  authState: AgentAuthState;
  workspaceCompatibility: AgentWorkspaceCompatibility;
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
  providerEventPath?: string;
  codexExecutable?: string;
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
const DETECT_CACHE_TTL_MS = 5_000;
const ProviderEventPathSchema = z.string()
  .trim()
  .min(1)
  .max(4096)
  .refine(isAbsolute)
  .regex(/^[^\u0000\r\n]+\.jsonl$/);
const CODEX_APP_SERVER_RUNNER_PATH = fileURLToPath(
  new URL("./coding-agents/codex-app-server-runner.mjs", import.meta.url),
);
const CodexAppServerConfigSchema = z.object({
  prompt: z.string().trim().min(1).max(64 * 1024),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  writableRoots: z.array(z.string().min(1).max(4096).refine(isAbsolute)).max(20),
}).strict();

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

function isExactVerifiedCodexVersion(version: string | undefined): boolean {
  if (!version) return false;
  const status = codexExecContractStatus(version);
  return status.status === "verified" && status.version === CODEX_VERIFIED_VERSION;
}

function promptArgs(prompt?: string): string[] {
  if (!prompt || prompt.length === 0) return [];
  return ["--", prompt];
}

function matrixNodePrefix(): string {
  const configured = process.env.MATRIX_NODE_PREFIX?.trim();
  return configured && configured.length > 0 ? configured : "/opt/matrix/runtime/node";
}

function pathWithMatrixAgentBins(runtimeHome: string, nodePrefix = matrixNodePrefix()): string {
  const preferred = [`${runtimeHome}/.local/bin`, `${nodePrefix}/bin`];
  const current = (process.env.PATH ?? "").split(":").filter(Boolean);
  return [
    ...preferred,
    ...current.filter((entry) => !preferred.includes(entry)),
  ].join(":");
}

function agentRuntimeEnv(runtimeHome?: string): Record<string, string> {
  if (!runtimeHome) return {};
  const nodePrefix = matrixNodePrefix();
  return {
    HOME: runtimeHome,
    MATRIX_HOME: runtimeHome,
    MATRIX_NODE_PREFIX: nodePrefix,
    PATH: pathWithMatrixAgentBins(runtimeHome, nodePrefix),
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
  if (
    input.approvalPolicy === "never" &&
    (input.sandbox?.mode === "danger-full-access" || input.sandbox?.enabled === false)
  ) {
    return "bypassPermissions";
  }
  if (
    input.sandbox?.enabled === true &&
    input.sandbox.mode !== "danger-full-access" &&
    (input.approvalPolicy === "on-request" || input.approvalPolicy === "never")
  ) {
    return "dontAsk";
  }
  return "default";
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
  const scopedEdits =
    (input.approvalPolicy === "on-request" || input.approvalPolicy === "never") &&
    input.mode !== "plan" &&
    input.mode !== "review";
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
    permissions: scopedEdits
      ? {
          allow: (sandbox.writableRoots ?? []).map(claudeEditPermissionRule),
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

function authStatusArgs(agent: Extract<SupportedAgent, "claude" | "codex">): string[] {
  return agent === "codex" ? ["login", "status"] : ["auth", "status"];
}

function commandErrorCode(err: unknown): unknown {
  return err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
}

function isExecutableMissingError(err: unknown): boolean {
  return commandErrorCode(err) === "ENOENT";
}

function isAuthenticationRequiredError(err: unknown): boolean {
  return typeof commandErrorCode(err) === "number";
}

function workspaceCompatibility(
  id: SupportedAgent,
  version: string | undefined,
): AgentWorkspaceCompatibility {
  if (id !== "codex") return "not_applicable";
  return isExactVerifiedCodexVersion(version) ? "compatible" : "unsupported";
}

function unavailableAgentStatus(
  id: SupportedAgent,
  state: Exclude<AgentInstallState, "installed">,
): AgentStatus {
  const config = AGENTS[id];
  return {
    id,
    command: config.command,
    displayName: config.displayName,
    installState: state,
    installed: state === "missing" ? false : null,
    authState: "unknown",
    workspaceCompatibility: id === "codex" ? "unknown" : "not_applicable",
    errorCode: state === "missing" ? "agent_missing" : "agent_check_failed",
  };
}

function codexModeArgs(mode?: AgentLaunchInput["mode"]): string[] {
  return mode === "review" ? ["review"] : [];
}

function codexPrompt(prompt: string | undefined, mode?: AgentLaunchInput["mode"]): string | undefined {
  if (mode !== "plan") return prompt;
  const planPrefix = "Plan the work first. Do not modify files until the plan is clear.";
  return prompt ? `${planPrefix}\n\n${prompt}` : planPrefix;
}

function codexAppServerConfig(input: AgentLaunchInput): z.infer<typeof CodexAppServerConfigSchema> {
  codexSandboxArgs(input.sandbox);
  const sandbox = input.sandbox;
  const mode = sandbox?.enabled === false
    ? "danger-full-access"
    : sandbox?.mode ?? "workspace-write";
  return CodexAppServerConfigSchema.parse({
    prompt: codexPrompt(input.prompt, input.mode),
    approvalPolicy: input.approvalPolicy === "on-failure"
      ? "on-request"
      : input.approvalPolicy ?? "never",
    sandbox: mode,
    writableRoots: mode === "workspace-write" ? sandbox?.writableRoots ?? [] : [],
  });
}

export function buildAgentLaunch(input: AgentLaunchInput): AgentLaunchSpec {
  const parsed = SupportedAgentSchema.parse(input.agent);
  const command = parsed === "codex" && input.codexExecutable
    ? CodexExecutableSchema.parse(input.codexExecutable)
    : AGENTS[parsed].command;
  const env = agentRuntimeEnv(input.runtimeHome);
  switch (parsed) {
    case "claude":
      return { command, args: claudeLaunchArgs(input), cwd: input.cwd, env };
    case "codex":
      {
        const args = [
          "--ask-for-approval",
          input.approvalPolicy ?? "never",
          ...codexSandboxArgs(input.sandbox),
          "exec",
          "--skip-git-repo-check",
          ...codexModeArgs(input.mode),
          ...promptArgs(codexPrompt(input.prompt, input.mode)),
        ];
        if (!input.providerEventPath) return { command, args, cwd: input.cwd, env };
        const providerEventPath = ProviderEventPathSchema.parse(input.providerEventPath);
        const appServerConfig = Buffer.from(
          JSON.stringify(codexAppServerConfig(input)),
          "utf8",
        ).toString("base64");
        return {
          command: process.execPath,
          args: [
            CODEX_APP_SERVER_RUNNER_PATH,
            providerEventPath,
            CODEX_VERIFIED_VERSION,
            command,
            appServerConfig,
          ],
          cwd: input.cwd,
          env,
        };
      }
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
  codexExecutable?: string;
  now?: () => number;
} = {}) {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const cwd = options.cwd ?? process.cwd();
  const detectEnv = agentRuntimeEnv(options.runtimeHome);
  const now = options.now ?? Date.now;
  type DetectionResult = { agents: AgentStatus[] };
  let installationScanInFlight: Promise<DetectionResult> | null = null;
  let installationScanCache: { result: DetectionResult; expiresAt: number } | null = null;
  let credentialScanInFlight: Promise<DetectionResult> | null = null;
  let credentialScanCache: { result: DetectionResult; expiresAt: number } | null = null;

  function commandFor(id: SupportedAgent): string {
    return id === "codex" && options.codexExecutable
      ? CodexExecutableSchema.parse(options.codexExecutable)
      : AGENTS[id].command;
  }

  async function probeInstallation(id: SupportedAgent): Promise<AgentStatus> {
    const config = AGENTS[id];
    try {
      const result = await runCommand(commandFor(id), ["--version"], {
        cwd,
        timeout: DETECT_TIMEOUT_MS,
        env: detectEnv,
      });
      const version = firstLine(result.stdout) ?? firstLine(result.stderr);
      const compatibility = workspaceCompatibility(id, version);
      return {
        id,
        command: config.command,
        displayName: config.displayName,
        installState: "installed",
        installed: true,
        authState: "unknown",
        workspaceCompatibility: compatibility,
        version,
        errorCode: compatibility === "unsupported" ? "agent_version_unsupported" : null,
      };
    } catch (err: unknown) {
      const state = isExecutableMissingError(err) ? "missing" : "unknown";
      console.warn(`[agent-launcher] ${config.command} installation probe failed:`, state);
      return unavailableAgentStatus(id, state);
    }
  }

  async function probeCredentials(
    id: Extract<SupportedAgent, "claude" | "codex">,
  ): Promise<AgentStatus> {
    const installation = await probeInstallation(id);
    if (installation.installState !== "installed") return installation;
    if (installation.workspaceCompatibility === "unsupported") {
      return { ...installation, authState: "error" };
    }

    try {
      await runCommand(commandFor(id), authStatusArgs(id), {
        cwd,
        timeout: DETECT_TIMEOUT_MS,
        env: detectEnv,
      });
      return { ...installation, authState: "ok", errorCode: null };
    } catch (err: unknown) {
      if (isExecutableMissingError(err)) return unavailableAgentStatus(id, "missing");
      if (isAuthenticationRequiredError(err)) {
        console.warn(`[agent-launcher] ${AGENTS[id].command} credential probe failed: auth_required`);
        return { ...installation, authState: "required", errorCode: "agent_auth_required" };
      }
      console.warn(`[agent-launcher] ${AGENTS[id].command} credential probe failed: check_failed`);
      return { ...installation, authState: "error", errorCode: "agent_check_failed" };
    }
  }

  async function detectAgentInstallations(): Promise<DetectionResult> {
    const cached = installationScanCache;
    if (cached && now() < cached.expiresAt) return cached.result;
    if (installationScanInFlight) return installationScanInFlight;

    const scan = Promise.all(SupportedAgentSchema.options.map(probeInstallation))
      .then((agents) => ({ agents }));
    installationScanInFlight = scan;
    try {
      const result = await scan;
      installationScanCache = { result, expiresAt: now() + DETECT_CACHE_TTL_MS };
      return result;
    } finally {
      if (installationScanInFlight === scan) installationScanInFlight = null;
    }
  }

  async function detectAgentCredentials(): Promise<DetectionResult> {
    const cached = credentialScanCache;
    if (cached && now() < cached.expiresAt) return cached.result;
    if (credentialScanInFlight) return credentialScanInFlight;

    const scan = Promise.all([
      probeCredentials("claude"),
      probeCredentials("codex"),
    ]).then((agents) => ({ agents }));
    credentialScanInFlight = scan;
    try {
      const result = await scan;
      credentialScanCache = { result, expiresAt: now() + DETECT_CACHE_TTL_MS };
      return result;
    } finally {
      if (credentialScanInFlight === scan) credentialScanInFlight = null;
    }
  }

  return {
    detectAgentInstallations,
    detectAgentCredentials,
    /** @deprecated Use detectAgentInstallations for executable availability. */
    detectAgents: detectAgentInstallations,

    buildLaunch(input: AgentLaunchInput): AgentLaunchSpec {
      return buildAgentLaunch({
        ...input,
        runtimeHome: input.runtimeHome ?? options.runtimeHome,
        codexExecutable: input.codexExecutable ?? options.codexExecutable,
      });
    },
  };
}
