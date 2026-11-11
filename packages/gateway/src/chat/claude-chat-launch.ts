import { isAbsolute } from "node:path";
import {
  CanonicalChatActionDigestSchema,
  CanonicalChatRunSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatRun,
  type CanonicalOwnerScope,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { buildAgentLaunch, type AgentLaunchSpec } from "../agent-launcher.js";
import { boundedOperation } from "../bounded-operation.js";
import type { KernelCredentialLaunch } from "../kernel-credentials.js";
import type { CanonicalCliSpawn } from "./cli-process.js";
import type { resolveClaudeNativeProtocol } from "./claude-native-protocol.js";
import type { resolveClaudeSessionSource } from "./claude-session-source.js";
import { configureClaudeSharedBrowserPresentation } from "./claude-shared-browser-launch.js";
import { supportsNativeSharedBrowser } from "./native-shared-browser-run.js";
import type { CanonicalProviderRunInput } from "./provider-adapter.js";

export const ClaudeChatStateSchema = z.object({
  sessionId: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,511}$/),
  model: z.string().min(1).max(160).optional(),
  /** A protected process never writes its newer turns to the native transcript. */
  canonicalHistoryRequired: z.literal(true).optional(),
}).strict();
export type ClaudeChatState = z.infer<typeof ClaudeChatStateSchema>;
export type ResolveClaudeCredentialLaunch = (context: { runId: string; instanceId: string }) => Promise<KernelCredentialLaunch>;

export function claudeChatPermissionMode(value: string, interactionMode: string) {
  if (interactionMode === "review") return "plan" as const;
  if (value === "supervised") return "default" as const;
  if (value === "auto_accept_edits") return "acceptEdits" as const;
  if (value === "auto") return "auto" as const;
  if (value === "full_access") return "bypassPermissions" as const;
  throw new Error("Unsupported Claude permission mode");
}

export function buildClaudeChatLaunch(options: {
  input: Pick<CanonicalProviderRunInput, "executionRoot" | "selection" | "interactionMode" | "context">;
  homePath: string;
  prompt: string;
  permissionMode: ReturnType<typeof claudeChatPermissionMode>;
  matrixCustomMcp: boolean;
  matrixCustomMcpScope: "chat_call" | "chat_discovery" | "preview_drive_call";
}): AgentLaunchSpec {
  const { input, permissionMode } = options;
  const cwd = input.executionRoot ?? options.homePath;
  const fullAccess = permissionMode === "bypassPermissions";
  return buildAgentLaunch({
    agent: "claude",
    cwd,
    runtimeHome: options.homePath,
    prompt: options.prompt,
    model: input.selection.model,
    modelOptions: input.selection.options ?? [],
    mode: input.interactionMode === "review" ? "review" : "default",
    approvalPolicy: fullAccess ? "never" : "on-request",
    sandbox: fullAccess
      ? { enabled: false, mode: "danger-full-access" }
      : { enabled: true, mode: "workspace-write", writableRoots: [cwd] },
    claudePermissionMode: permissionMode,
    claudeOutputFormat: "stream-json",
    claudeIncludePartialMessages: true,
    matrixCustomMcp: options.matrixCustomMcp,
    matrixDriveContext: Boolean(input.context?.drives?.length),
    matrixCustomMcpScope: options.matrixCustomMcpScope,
  });
}

export function finishClaudeChatLaunch(launch: AgentLaunchSpec, sessionId?: string): void {
  const promptSeparator = launch.args.indexOf("--");
  if (promptSeparator >= 0) launch.args.splice(promptSeparator);
  if (sessionId) launch.args.push("--resume", sessionId);
  launch.args.push("--input-format", "stream-json", "--permission-prompt-tool", "stdio");
}

export function claudeChatLaunchEnvironment(launch: AgentLaunchSpec, credentialEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...credentialEnv, ...launch.env })) {
    if (value !== undefined) env[name] = value;
  }
  // Never inherit host or previous Run capabilities, including fallback without an issuer.
  for (const name of ["MATRIX_AUTH_TOKEN", "UPGRADE_TOKEN", "MATRIX_CODE_PROXY_TOKEN", "AI_RELAY_CONTROL_TOKEN",
    "MATRIX_AGENT_INTEGRATIONS_TOKEN", "MATRIX_SHARED_BROWSER_TOKEN", "MATRIX_SHARED_BROWSER_GATEWAY_PORT"]) {
    delete env[name];
  }
  return env;
}

export interface ClaudeNativeRecoveryLaunchInput {
  owner: CanonicalOwnerScope;
  run: CanonicalChatRun;
  state: unknown;
  sessionId: string;
  executionRoot?: string;
  expectedSourceFingerprint: string;
  signal: AbortSignal;
}

export interface ClaudeNativeRecoveryLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sourceFingerprint: string;
  sessionId: string;
}

const RECOVERY_ENV = [
  "HOME", "PATH", "LANG", "LC_ALL", "TZ", "MATRIX_HOME", "MATRIX_NODE_PREFIX", "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL", "CLAUDE_CODE_DISABLE_CRON", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;
const RECOVERY_PERMISSION_MODES = ["supervised", "auto_accept_edits", "auto", "full_access"] as const;

/** Build and verify the private idle launch. The launcher owns the sealed resume selector. */
export async function prepareClaudeNativeRecovery(options: {
  homePath: string;
  resolveCredentialLaunch?: ResolveClaudeCredentialLaunch;
  resolveNativeProtocol: typeof resolveClaudeNativeProtocol;
  resolveSessionSource: typeof resolveClaudeSessionSource;
  spawnFn?: CanonicalCliSpawn;
  matrixCustomMcp: boolean;
  sharedBrowser: boolean;
}, recovery: ClaudeNativeRecoveryLaunchInput): Promise<ClaudeNativeRecoveryLaunchPlan | null> {
  const owner = CanonicalOwnerScopeSchema.safeParse(recovery.owner);
  const run = CanonicalChatRunSchema.safeParse(recovery.run);
  const state = ClaudeChatStateSchema.safeParse(recovery.state);
  const resolveCredentialLaunch = options.resolveCredentialLaunch;
  if (!resolveCredentialLaunch || !owner.success || owner.data.type !== "personal"
    || !run.success || run.data.driverKind !== "claude_code" || run.data.status !== "completed" || run.data.outcome !== "completed"
    || run.data.instanceId === "claude_code_matrix_included" || run.data.interactionMode !== "default" || run.data.context?.agent
    || run.data.context?.drives?.length || !RECOVERY_PERMISSION_MODES.some(mode => mode === run.data.permissionMode)
    || !state.success || state.data.sessionId !== recovery.sessionId || !z.uuid().safeParse(recovery.sessionId).success
    || !CanonicalChatActionDigestSchema.safeParse(recovery.expectedSourceFingerprint).success
    || (run.data.executionRoot === undefined) !== (recovery.executionRoot === undefined)
    || (recovery.executionRoot !== undefined && (!isAbsolute(recovery.executionRoot) || recovery.executionRoot.includes("\0")))) {
    return null;
  }
  const { signal } = recovery;
  const { env: credentialEnv, fundedRunTimeoutMs } = await boundedOperation(
    () => resolveCredentialLaunch({ runId: run.data.id, instanceId: run.data.instanceId }),
    10_000,
    signal,
  );
  signal.throwIfAborted();
  if (!credentialEnv || fundedRunTimeoutMs !== undefined
    || credentialEnv.ANTHROPIC_AUTH_TOKEN || credentialEnv.CLAUDE_CODE_OAUTH_TOKEN || credentialEnv.ANTHROPIC_CUSTOM_HEADERS
    || credentialEnv.CLAUDE_CONFIG_DIR || credentialEnv.NODE_OPTIONS) return null;

  const input = { owner: owner.data, chatId: run.data.chatId, selection: run.data.selection,
    interactionMode: run.data.interactionMode, permissionMode: run.data.permissionMode, executionRoot: recovery.executionRoot,
    context: run.data.context };
  const launch = buildClaudeChatLaunch({ input, homePath: options.homePath,
    // A nonempty value selects Claude's print transport. Its positional arguments are removed below.
    prompt: "Native scheduled Chat recovery", permissionMode: claudeChatPermissionMode(input.permissionMode, input.interactionMode),
    matrixCustomMcp: options.matrixCustomMcp, matrixCustomMcpScope: "chat_call" });
  if (options.sharedBrowser && supportsNativeSharedBrowser(input)) configureClaudeSharedBrowserPresentation(launch);
  finishClaudeChatLaunch(launch);
  const mergedEnv = claudeChatLaunchEnvironment(launch, credentialEnv);
  const env = Object.fromEntries(RECOVERY_ENV.flatMap(name => mergedEnv[name] === undefined ? [] : [[name, mergedEnv[name]!]]));
  const { command, qualified } = await options.resolveNativeProtocol({
    command: launch.command, cwd: launch.cwd, env, signal, spawnFn: options.spawnFn,
  });
  signal.throwIfAborted();
  if (!qualified || !isAbsolute(command)) return null;
  const args = launch.args.filter((_arg, index, values) => values[index] !== "--mcp-config" && values[index - 1] !== "--mcp-config");
  const source = await options.resolveSessionSource({ homePath: options.homePath, command, cwd: launch.cwd, args, env, input });
  signal.throwIfAborted();
  if (!source.schedulingAllowed || source.fingerprint !== recovery.expectedSourceFingerprint) return null;
  return { command, args, cwd: launch.cwd, env, sourceFingerprint: source.fingerprint, sessionId: recovery.sessionId };
}
