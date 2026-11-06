import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { CodexNativeAccountMetadataReader, CodexNativeAccountObservation } from "./codex-native-account-metadata.js";
import type { ProviderSettingsConfiguration } from "./provider-settings-persistence.js";

export type CodexCatalogObservation = "checking" | "authentication_required";
// Read-scoped classification only; a public DTO clone cannot carry this state or
// private identity proof into another runtime. Weak entries expire with snapshots.
const observations = new WeakMap<ProviderSettingsSnapshot, CodexCatalogObservation>();

export async function observeCodexNativeAccount(reader: CodexNativeAccountMetadataReader | undefined,
  includeUsage: boolean): Promise<CodexNativeAccountObservation> {
  if (!reader) return { metadata: null, state: "unavailable" };
  if (!includeUsage && reader.observeIdentity) return reader.observeIdentity();
  const metadata = includeUsage ? await reader() : await reader({ includeUsage: false });
  return { metadata, state: metadata ? "observed" : "unavailable" };
}

/** A completed saved consent permits display only; current identity still gates admission. */
export function markCodexCatalogObservation(snapshot: ProviderSettingsSnapshot, config: ProviderSettingsConfiguration,
  state: CodexNativeAccountObservation["state"] | undefined): ProviderSettingsSnapshot {
  if (state === "signed_out" || state === "changed") observations.set(snapshot, "authentication_required");
  if (state === "unavailable") {
    const rows = config.harnesses.filter(row => row.harness === "codex");
    const row = rows[0];
    if (rows.length === 1 && row?.enabled && row.driverId === "codex"
      && row.accessSourceId === "owner_openai_profile" && row.selectedAccountId === "owner_codex"
      && row.nativeAccountGeneration && row.nativeAccountConsentRevision !== undefined) {
      observations.set(snapshot, "checking");
    }
  }
  return snapshot;
}

export function codexCatalogObservation(snapshot: ProviderSettingsSnapshot | null | undefined): CodexCatalogObservation | undefined {
  return snapshot ? observations.get(snapshot) : undefined;
}
