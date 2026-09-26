import { isLocallyObservedNativeHarnessRoute, type AiProviderSnapshotV3, type ProviderAccessSource } from "@matrix-os/contracts";
import type { GenericHarnessModelCatalog } from "./generic-harness-model-catalog.js";
import type { HarnessConfiguration } from "./provider-settings-persistence.js";

export function generatedNativeHarnessConfiguration(
  driver: AiProviderSnapshotV3["drivers"][number], catalog: GenericHarnessModelCatalog | undefined, now: Date,
): HarnessConfiguration | null {
  if ((driver.id !== "pi" && driver.id !== "opencode") || !catalog || catalog.failures.includes(driver.id)) return null;
  const modelId = catalog.nativeDefaults?.[driver.id];
  if (!modelId) return null;
  const source = catalog.accessSources.find((candidate) => candidate.kind === "harness_profile" && candidate.harness === driver.id
    && candidate.eligibleModelIds.includes(modelId) && catalog.providers.some((provider) => provider.id === candidate.providerId
      && provider.models.some((model) => model.id === modelId && model.enabled)));
  if (!source) return null;
  const qualified = { ...source, readiness: { ...source.readiness, state: "unknown" as const } };
  return {
    id: `harness_${driver.id}`, driverId: driver.id, harness: driver.id, displayName: driver.displayName, accentColor: null,
    enabled: driver.installState === "installed" && driver.health !== "unavailable" && driver.health !== "stopped"
      && isLocallyObservedNativeHarnessRoute({ harness: driver.id, accessSourceId: source.id, route: { kind: "configurable", providerId: source.providerId, modelId } }, qualified, now),
    enablementOrigin: "generated_default", selectedAccountId: null, accessSourceId: source.id,
    route: { kind: "configurable", providerId: source.providerId, modelId },
  };
}

/** Model discovery alone cannot authenticate the selected native credential. */
export function qualifyGeneratedNativeSource(
  source: ProviderAccessSource, canonical: AiProviderSnapshotV3, generatedSourceIds: ReadonlySet<string>,
): ProviderAccessSource {
  if (source.kind !== "harness_profile" || !generatedSourceIds.has(source.id)) return source;
  const driver = canonical.drivers.find((candidate) => candidate.id === source.harness);
  return { ...source, readiness: {
    state: driver?.health === "stopped" ? "auth_required" : "unknown", checkedAt: null, staleAfter: null,
    action: driver?.health === "stopped" ? "connect" : "retry", safeReason: "unknown",
  } };
}
