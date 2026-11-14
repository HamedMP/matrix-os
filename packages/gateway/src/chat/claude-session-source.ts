import { createHash } from "node:crypto";
import { createClaudeNativeAccountMetadataReader } from "../ai-providers/claude-native-account-metadata.js";
import type { CodexNativeAccountMetadata } from "../ai-providers/codex-native-account-metadata.js";
import { nativeAccountPrincipalFingerprint, verifyNativeAccountMetadata } from "../ai-providers/native-account-metadata-binding.js";
import type { CanonicalProviderRunInput } from "./provider-adapter.js";

export interface ClaudeSessionSource {
  fingerprint: string;
  schedulingAllowed: boolean;
}

function stableArgs(args: string[]): string[] {
  const retained: string[] = [];
  for (let index = 0; index < args.length; index++) {
    // These configure the current transport phase, not the retained process scope.
    if (args[index] === "--resume" || args[index] === "--mcp-config") { index++; continue; }
    retained.push(args[index]!);
  }
  return retained;
}

/** Equality evidence only. No fingerprint or native account observation grants execution. */
export async function resolveClaudeSessionSource(options: {
  homePath: string;
  command: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  input: Pick<CanonicalProviderRunInput,
    "owner" | "chatId" | "selection" | "permissionMode" | "interactionMode" | "executionRoot" | "sharedScopeId" | "context">;
  readNativeMetadata?: () => Promise<CodexNativeAccountMetadata | null>;
}): Promise<ClaudeSessionSource> {
  const { input, env } = options;
  const eligible = input.owner.type === "personal" && input.interactionMode === "default"
    && !input.sharedScopeId && !input.context?.agent;
  const ambiguousCredential = Boolean(env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN);
  let principal: string | null = null;
  if (!ambiguousCredential && env.ANTHROPIC_API_KEY) {
    // The caller supplies the already-selected owner launch environment, never ambient credentials.
    principal = createHash("sha256").update(env.ANTHROPIC_API_KEY).digest("hex");
  } else if (!ambiguousCredential && !env.CLAUDE_CONFIG_DIR && eligible) {
    try {
      const read = options.readNativeMetadata ?? createClaudeNativeAccountMetadataReader({
        executable: options.command, cwd: options.homePath, environment: env,
      });
      const current = await verifyNativeAccountMetadata(await read());
      principal = current?.authMethod === "terminal" ? nativeAccountPrincipalFingerprint(current) : null;
    } catch (error: unknown) {
      // Native writer contention or an unavailable observation disables retention only.
      console.warn("[chat-claude] Native session identity unavailable", error instanceof Error ? error.name : "UnknownError");
    }
  }
  const stableEnvironment = Object.fromEntries([
    "HOME", "PATH", "LANG", "LC_ALL", "TZ", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_DISABLE_CRON", "NODE_OPTIONS", "MATRIX_NODE_PREFIX",
  ].flatMap(name => env[name] === undefined ? [] : [[name, env[name]]]));
  return {
    schedulingAllowed: eligible && principal !== null,
    fingerprint: createHash("sha256").update(JSON.stringify({
      owner: input.owner, chatId: input.chatId, instanceId: input.selection.instanceId,
      selection: input.selection, permissionMode: input.permissionMode, interactionMode: input.interactionMode,
      executionRoot: input.executionRoot ?? null, homePath: options.homePath, cwd: options.cwd,
      command: options.command, args: stableArgs(options.args), environment: stableEnvironment,
      source: env.ANTHROPIC_API_KEY ? "owner_key" : "owner_native", principal,
    })).digest("hex"),
  };
}
