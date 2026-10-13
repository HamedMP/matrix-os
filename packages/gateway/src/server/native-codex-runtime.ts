import { createCodexNativeAccountMetadataReader } from "../ai-providers/codex-native-account-metadata.js";
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
import type { ProviderSettingsStore } from "../ai-providers/provider-settings-store.js";
import { createCodexExecutionAdmission } from "../coding-agents/codex-execution-admission.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";

/** One owner-scoped native identity and execution authority for gateway composition. */
export function createNativeCodexRuntime(options: {
  homePath: string;
  executable?: string;
  ownerIds: readonly string[];
  environment(): Record<string, string>;
  profileGuard: Pick<NativeProviderProfileGuard, "assertReadable">;
  getSettings(): Pick<ProviderSettingsStore, "getSnapshot"> | undefined;
  getRuntime(): Pick<WorkspaceSessionOrchestrator, "stopSession"> | null | undefined;
}) {
  let reader: ReturnType<typeof createCodexNativeAccountMetadataReader> | undefined;
  const readAccount = async () => {
    if (!options.executable) return null;
    try {
      reader ??= createCodexNativeAccountMetadataReader({
        executable: options.executable, cwd: options.homePath, environment: options.environment(),
      });
      await options.profileGuard.assertReadable("codex");
      const metadata = await reader();
      await options.profileGuard.assertReadable("codex");
      return metadata;
    } catch (error) {
      console.warn("[provider-settings] Native Codex identity unavailable:", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  };
  const admission = createCodexExecutionAdmission({
    homePath: options.homePath,
    isOwner: userId => options.ownerIds.includes(userId),
    getSnapshot: async () => {
      const settings = options.getSettings();
      if (!settings) throw new Error("Provider settings are unavailable");
      return settings.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false });
    },
    readNativeAccount: readAccount,
    assertProfileAvailable: () => options.profileGuard.assertReadable("codex"),
    stopSession: async sessionId => {
      const runtime = options.getRuntime();
      if (!runtime) throw new Error("Native session runtime is unavailable");
      const stopped = await runtime.stopSession(sessionId);
      if (!stopped.ok) throw new Error("Native session cleanup is unavailable");
    },
  });
  return {
    admission,
    readAccount,
    resolveSubscription: async (ownerId: string, sessionId: string) => {
      const intent = await admission.validateLaunch(ownerId, sessionId);
      if (!intent) return undefined;
      return { ...intent, codexHome: options.environment().CODEX_HOME! };
    },
    beforeProjectSessionRemove: ({ ownerId, sessionId, proof }: { ownerId: string; sessionId: string; proof: object }) =>
      admission.releaseStoppedSession(ownerId, sessionId, proof),
  };
}
