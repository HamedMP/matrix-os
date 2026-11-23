import { randomUUID } from "node:crypto";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { CodexNativeAccountMetadata } from "./codex-native-account-metadata.js";
import { nativeAccountLegacyPrincipalFingerprint, nativeAccountPrincipalFingerprint, sameBoundNativeAccountPrincipal, type NativeAccountCompletionProof } from "./native-account-metadata-binding.js";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";
import { ProviderSettingsStoreError } from "./provider-settings-errors.js";
import { savedCodexConsentMatches, type CodexConsentAlias } from "../coding-agents/codex-consent-alias.mjs";

type RecoveryKind = "complete" | "alias";

function savedCodexRow(config: ProviderSettingsConfiguration) {
  const rows = config.harnesses.filter(row => row.harness === "codex");
  const row = rows.length === 1 ? rows[0] : undefined;
  return row?.enabled && row.driverId === "codex"
    && row.accessSourceId === "owner_openai_profile" && row.selectedAccountId === "owner_codex"
    && row.route.kind === "fixed" && row.route.providerId === "openai" ? row : undefined;
}

function recoveryKind(config: ProviderSettingsConfiguration, metadata?: CodexNativeAccountMetadata | null,
  alias?: CodexConsentAlias | null): RecoveryKind | null {
  const row = savedCodexRow(config);
  if (!row) return null;
  if (!row.nativeAccountGeneration || row.nativeAccountConsentRevision === undefined) return "complete";
  if (metadata?.authMethod !== "terminal") return null;
  if (savedCodexConsentMatches(row.nativeAccountGeneration, nativeAccountPrincipalFingerprint(metadata), alias)) return null;
  return nativeAccountLegacyPrincipalFingerprint(metadata) === row.nativeAccountGeneration ? "alias" : null;
}

/** Saved native selection is existing approval; missing bookkeeping is repairable.
 * Consent saved under the legacy token-bound generation of this same, still-current
 * credential is upgraded by recording an alias (ENG-523), never by rewriting the
 * saved row, so session bindings and live runners keep their identity. Never turn
 * a changed, previously bound principal into an automatic account switch.
 */
export function codexNativeConnectionNeedsRecovery(config: ProviderSettingsConfiguration, metadata?: CodexNativeAccountMetadata | null,
  alias?: CodexConsentAlias | null): boolean {
  return recoveryKind(config, metadata, alias) !== null;
}

type RecoveryInput = { harnessInstanceId: string; expectedRevision: number; idempotencyKey: string; verifyNativeAccount: NativeAccountCompletionProof };

/** One bounded in-flight repair per store: the guarded completion saga for missing
 * consent, the guarded alias write for a same-account upgrade. */
export function createCodexNativeConnectionRecovery(
  complete: (input: RecoveryInput) => Promise<{ snapshot: ProviderSettingsSnapshot }>,
  recordAlias?: (input: Omit<RecoveryInput, "idempotencyKey">) => Promise<{ snapshot: ProviderSettingsSnapshot }>,
) {
  let pending: { revision: number; result: Promise<ProviderSettingsSnapshot> } | undefined;
  return async (config: ProviderSettingsConfiguration, metadata: CodexNativeAccountMetadata | null,
    alias?: CodexConsentAlias | null): Promise<ProviderSettingsSnapshot | null> => {
    const kind = recoveryKind(config, metadata, alias);
    if (!kind || metadata?.authMethod !== "terminal" || (kind === "alias" && !recordAlias)) return null;
    const row = savedCodexRow(config)!;
    const fingerprint = nativeAccountPrincipalFingerprint(metadata);
    if (!fingerprint || (kind === "complete" && row.nativeAccountGeneration && row.nativeAccountGeneration !== fingerprint)) return null;
    if (pending) {
      // A different revision must be reobserved by the caller's existing fence.
      if (pending.revision !== config.revision) throw new ProviderSettingsStoreError("revision_conflict", 409);
      return pending.result;
    }
    const request = { harnessInstanceId: row.id, expectedRevision: config.revision,
      verifyNativeAccount: async (current: CodexNativeAccountMetadata) => sameBoundNativeAccountPrincipal(metadata, current) };
    const result = (kind === "alias" ? recordAlias!(request) : complete({ ...request, idempotencyKey: `codex-recovery:${randomUUID()}` }))
      .then(value => value.snapshot).catch((error: unknown) => {
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
