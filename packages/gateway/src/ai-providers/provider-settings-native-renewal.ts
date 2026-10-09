import { AiProviderSnapshotV3Schema, type AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { CanonicalProviderSnapshotReader } from "./provider-settings-coordinators.js";
import type { ProviderSettingsEnrichment } from "./provider-settings-enrichment.js";
import type { NativeObservationReadScope } from "./hermes-observation-renewal.js";
import { projectCanonicalNativeHarnessCatalog } from "./native-harness-canonical-projection.js";

/** Refresh canonical and compatibility evidence together, outside configuration writes. */
export async function renewProviderSettingsNativeObservation(captured: {
  canonical: AiProviderSnapshotV3; enrichment: ProviderSettingsEnrichment;
}, reader: CanonicalProviderSnapshotReader, scope: NativeObservationReadScope) {
  if (!reader.renewNativeObservations) return captured;
  const next = await reader.renewNativeObservations(captured.canonical, scope);
  if (next === captured.canonical) return captured;
  const canonical = AiProviderSnapshotV3Schema.parse(next);
  return { canonical, enrichment: { ...captured.enrichment,
    ...(canonical.nativeHarnessCatalog ? { genericModelCatalog: projectCanonicalNativeHarnessCatalog(canonical.nativeHarnessCatalog) } : {}) } };
}
