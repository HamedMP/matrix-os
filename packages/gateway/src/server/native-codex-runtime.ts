import { randomUUID } from "node:crypto";
import { createCodexNativeAccountMetadataReader, type CodexNativeAccountMetadataReader, type CodexNativeAccountObservation } from "../ai-providers/codex-native-account-metadata.js";

/**
 * Admission-time native identity reuse window (owner review: ENG-540). One
 * file-backed private identity proof serves Chat catalog and execution
 * admission for up to 10 minutes while the auth.json digest, executable, and
 * Codex config are unchanged (rechecked on every reuse). Login, logout, remove,
 * and revocation drop it. Runner thread/turn account proofs re-prove the live
 * account before turn/start and remain the execution authority.
 */
const ADMISSION_IDENTITY_REUSE_MS = 10 * 60_000;
import type { NativeProviderProfileGuard } from "../ai-providers/native-provider-profile-guard.js";
import type { ProviderSettingsStore } from "../ai-providers/provider-settings-store.js";
import { createCodexExecutionAdmission } from "../coding-agents/codex-execution-admission.js";
import { SessionStartBusyError } from "../session-start-guard.js";
import type { WorkspaceSessionOrchestrator } from "../workspace-session-orchestrator.js";

/** One owner-scoped native identity and execution authority for gateway composition. */
export function createNativeCodexRuntime(options: {
  homePath: string;
  executable?: string;
  ownerIds: readonly string[];
  environment(): Record<string, string>;
  profileGuard: Pick<NativeProviderProfileGuard, "assertReadable">;
  getSettings(): Pick<ProviderSettingsStore, "getSnapshot"> | undefined;
  getRuntime(): Pick<WorkspaceSessionOrchestrator, "startSession" | "stopSession" | "withSessionStart"> | null | undefined;
}) {
  let reader: ReturnType<typeof createCodexNativeAccountMetadataReader> | undefined;
  async function guardedRead<T>(observe: (current: CodexNativeAccountMetadataReader) => Promise<T>, unavailable: T): Promise<T> {
    if (!options.executable) return unavailable;
    try {
      reader ??= createCodexNativeAccountMetadataReader({
        executable: options.executable, cwd: options.homePath, environment: options.environment(),
        identityReuseMs: ADMISSION_IDENTITY_REUSE_MS,
      });
      await options.profileGuard.assertReadable("codex");
      const result = await observe(reader);
      await options.profileGuard.assertReadable("codex");
      return result;
    } catch (error) {
      console.warn("[provider-settings] Native Codex identity unavailable:", error instanceof Error ? error.name : "UnknownError");
      return unavailable;
    }
  }
  const readAccount: CodexNativeAccountMetadataReader = readOptions => guardedRead(current => current(readOptions), null);
  readAccount.observeIdentity = () => guardedRead<CodexNativeAccountObservation>(async current => {
    if (current.observeIdentity) return current.observeIdentity();
    const metadata = await current({ includeUsage: false });
    return { metadata, state: metadata ? "observed" : "unavailable" };
  }, { metadata: null, state: "unavailable" });
  // This synchronous classification reads only the private verifier's outcome;
  // it performs no observation and supplies no execution authority.
  readAccount.identityFailureState = metadata => reader?.identityFailureState?.(metadata) ?? "unavailable";
  // Settings login/logout/remove/revocation drop the reused admission identity.
  readAccount.invalidateIdentity = () => { reader?.invalidateIdentity?.(); };
  const admission = createCodexExecutionAdmission({
    homePath: options.homePath,
    isOwner: userId => options.ownerIds.includes(userId),
    getSnapshot: async () => {
      const settings = options.getSettings();
      if (!settings) throw new Error("Provider settings are unavailable");
      // Execution admission only consults the Codex row; Claude/Hermes probes add latency only.
      return settings.getSnapshot({ includeNativeAccountMetadata: true, includeNativeAccountUsage: false, nativeAccountHarnesses: ["codex"] });
    },
    // Identity admission never depends on optional allowance metadata.
    readNativeAccount: () => readAccount({ includeUsage: false }),
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
    /** Login, logout, and executable changes must not serve a reused admission identity. */
    invalidateIdentity: () => { reader?.invalidateIdentity?.(); },
    /** Wrap a login/logout invalidation hook so it also drops the reused identity. */
    withIdentityInvalidation: (invalidate: () => void) => () => { invalidate(); reader?.invalidateIdentity?.(); },
    // Public workspace starts share the thread runtime and its exact cleanup
    // proofs. Reserve before sandbox preparation; final manager dispatch still
    // revalidates the registered binding through resolveSubscription below.
    startSession: async (input: Parameters<WorkspaceSessionOrchestrator["startSession"]>[0]): ReturnType<WorkspaceSessionOrchestrator["startSession"]> => {
      const runtime = options.getRuntime();
      if (!runtime?.startSession) return { ok: false, status: 503, error: { code: "runtime_unavailable", message: "Session runtime is unavailable" } };
      if (input.request.kind !== "agent" || input.request.agent !== "codex") return runtime.startSession(input);
      const sessionId = input.request.sessionId ?? `sess_${randomUUID()}`;
      if (!/^sess_[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return { ok: false, status: 400, error: { code: "invalid_session_id", message: "Session identifier is invalid" } };
      if (!runtime.withSessionStart) return { ok: false, status: 503, error: { code: "runtime_unavailable", message: "Session runtime is unavailable" } };
      try {
        // Keep registration and clean-failure release under the existing start
        // reservation so older cleanup cannot delete a newer start's binding.
        return await runtime.withSessionStart(input.ownerScope.id, sessionId, async scope => {
          let binding: string | undefined;
          try {
            if (input.ownerScope.type !== "user") throw new Error("Native owner scope is unavailable");
            binding = await admission.start(input.ownerScope.id, sessionId);
          } catch (error: unknown) {
            console.warn("[native-codex] Session admission unavailable:", error instanceof Error ? error.name : "UnknownError");
            return { ok: false, status: 400, error: { code: "native_account_unavailable", message: "Selected account is unavailable" } };
          }
          // A thrown or unproved failure retains the execution reference. Missing
          // session metadata cannot prove that an attempted Terminal child stopped.
          const result = await scope.startSession({ ...input, request: { ...input.request, sessionId } });
          if (!result.ok) await admission.releaseFailedStart(input.ownerScope.id, sessionId, binding, result);
          return result;
        });
      } catch (error: unknown) {
        if (error instanceof SessionStartBusyError) return { ok: false, status: 503, error: { code: "runtime_ownership_retained", message: "Session runtime is unavailable" } };
        throw error;
      }
    },
    resolveSubscription: async (ownerId: string, sessionId: string) => {
      const intent = await admission.validateLaunch(ownerId, sessionId);
      if (!intent) return undefined;
      return { ...intent, codexHome: options.environment().CODEX_HOME! };
    },
    beforeProjectSessionRemove: ({ ownerId, sessionId, proof }: { ownerId: string; sessionId: string; proof: object }) =>
      admission.releaseStoppedSession(ownerId, sessionId, proof),
  };
}
