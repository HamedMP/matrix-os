import type { CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { ProviderSettingsStore } from "../ai-providers/provider-settings-store.js";
import { createClaudeNativeAccountMetadataReader } from "../ai-providers/claude-native-account-metadata.js";
import { createHermesNativeAccountMetadataReader } from "../ai-providers/hermes-native-account-metadata.js";
import { createCodexNativeAccountMetadataReader } from "../ai-providers/codex-native-account-metadata.js";

/** Existing executable projection, independent of observation or admission. */
export function executableChatDrivers(providers: readonly { providerId: string }[], hasCodingThreads: boolean): CanonicalProviderDriverKind[] {
  return ["kernel", "hermes", "openclaw",
    ...(providers.some(provider => provider.providerId === "claude") ? ["claude_code" as const] : []),
    ...(hasCodingThreads && providers.some(provider => provider.providerId === "codex") ? ["codex" as const] : []),
    ...(hasCodingThreads && providers.some(provider => provider.providerId === "pi") ? ["pi" as const] : []),
    ...(hasCodingThreads && providers.some(provider => provider.providerId === "opencode") ? ["opencode" as const] : [])];
}

/** Reuse the Settings constructor contract instead of introducing a new bag of dependencies. */
export function createRuntimeProviderSettings(options: ConstructorParameters<typeof ProviderSettingsStore>[0] & { codexExecutable?: string }) {
  const { codexExecutable, ...storeOptions } = options;
  const { homePath } = storeOptions;
  return new ProviderSettingsStore({ ...storeOptions,
    claudeNativeAccountMetadataReader: createClaudeNativeAccountMetadataReader({ executable: "claude", cwd: homePath, environment: buildAgentRuntimeEnvironment(homePath) }),
    hermesNativeAccountMetadataReader: createHermesNativeAccountMetadataReader({ homePath }),
    ...(codexExecutable ? { codexNativeAccountMetadataReader: createCodexNativeAccountMetadataReader({ executable: codexExecutable, cwd: homePath,
      environment: { ...buildAgentRuntimeEnvironment(homePath), ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}) } }) } : {}),
  });
}
