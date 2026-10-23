import { randomUUID } from "node:crypto";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";
import { nativeAccountPrincipalFingerprint, sameBoundNativeAccountPrincipal, type NativeAccountCompletionProof } from "./native-account-metadata-binding.js";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";

/** Saved native selection is existing approval; missing bookkeeping is repairable.
 * Never turn a changed, previously bound principal into an automatic account switch.
 */
export function codexNativeConnectionNeedsRecovery(config: ProviderSettingsConfiguration): boolean {
  const rows = config.harnesses.filter(row => row.harness === "codex");
  const row = rows.length === 1 ? rows[0] : undefined;
  return Boolean(row?.enabled && row.driverId === "codex"
    && row.accessSourceId === "owner_openai_profile" && row.selectedAccountId === "owner_codex"
    && row.route.kind === "fixed" && row.route.providerId === "openai"
    && (!row.nativeAccountGeneration || row.nativeAccountConsentRevision === undefined));
}

/** One bounded in-flight repair per store, using the existing guarded completion saga. */
export function createCodexNativeConnectionRecovery(complete: (input: {
  harnessInstanceId: string; expectedRevision: number; idempotencyKey: string;
  verifyNativeAccount: NativeAccountCompletionProof;
}) => Promise<{ snapshot: ProviderSettingsSnapshot }>) {
  let pending: { revision: number; result: Promise<ProviderSettingsSnapshot> } | undefined;
  return async (config: ProviderSettingsConfiguration, metadata: CodexNativeAccountMetadata | null): Promise<ProviderSettingsSnapshot | null> => {
    if (!codexNativeConnectionNeedsRecovery(config) || metadata?.authMethod !== "terminal") return null;
    const row = config.harnesses.find(row => row.harness === "codex")!;
    const fingerprint = nativeAccountPrincipalFingerprint(metadata);
    if (!fingerprint || row.nativeAccountGeneration && row.nativeAccountGeneration !== fingerprint) return null;
    if (pending) {
      // A different revision must be reobserved by the caller's existing fence.
      if (pending.revision !== config.revision) throw new ProviderSettingsStoreError("revision_conflict", 409);
      return pending.result;
    }
    const result = complete({
      harnessInstanceId: row.id, expectedRevision: config.revision,
      idempotencyKey: `codex-recovery:${randomUUID()}`,
      verifyNativeAccount: async current => sameBoundNativeAccountPrincipal(metadata, current),
    }).then(result => result.snapshot).catch((error: unknown) => {
      // Retry transient/unverifiable completion rather than projecting a valid
      // login as signed out. Conflicts are handled by the store read's retry.
      if (error instanceof ProviderSettingsStoreError && error.code === "revision_conflict") throw error;
      console.warn("[provider-settings] Codex connection recovery unavailable:", error instanceof Error ? error.name : "UnknownError");
      throw new ProviderSettingsStoreError("projection_unavailable", 503);
    }).finally(() => { pending = undefined; });
    pending = { revision: config.revision, result };
    return result;
  };
}
