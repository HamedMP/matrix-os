import type { CanonicalProviderCatalog, CanonicalProviderDriverKind, CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";
import { canonicalProviderFundingState, isLegacyMatrixSdkProvider, isPiBotCoordinatorRoute, isChatgptPlanBotRoute } from "@matrix-os/contracts";
import { canonicalProviderAvailabilityLabel, orderCanonicalProviderInstancesForDefault, type CanonicalProviderChoice } from "./canonical-provider-choice.js";

export interface ChatPickerEntry {
  id: string;
  label: string;
  iconKind: CanonicalProviderDriverKind;
  instances: CanonicalProviderInstanceDescriptor[];
  capabilityClass: CanonicalProviderCatalog["drivers"][number]["capabilityClass"];
}

/** Presentation groups retain real server instance IDs; Matrix AI is an access source. */
export function deriveChatPickerEntries(catalog: CanonicalProviderCatalog): ChatPickerEntry[] {
  const visibleInstances = catalog.instances.filter(instance => !isChatgptPlanBotRoute({ instanceId: instance.id, driverKind: instance.driverKind }) || instance.supports.rootChat);
  const managed = visibleInstances.filter(instance => isPiBotCoordinatorRoute({ instanceId: instance.id, driverKind: instance.driverKind }));
  return [{ id: "matrix-ai", label: "Matrix AI", iconKind: "kernel", instances: managed, capabilityClass: "system_agent" },
    ...catalog.drivers.flatMap(driver => visibleInstances.filter(instance => instance.driverKind === driver.kind && !isLegacyMatrixSdkProvider(instance)
      && !managed.some(candidate => candidate.id === instance.id))
      .map(instance => ({ id: instance.id, label: instance.displayName, iconKind: instance.driverKind,
        instances: [instance], capabilityClass: driver.capabilityClass })))];
}

export function chatPickerEntryForSelection(entries: ChatPickerEntry[], instanceId?: string): string {
  return entries.find(entry => entry.instances.some(instance => instance.id === instanceId))?.id
    ?? entries.find(entry => entry.instances.length > 0)?.id ?? entries[0]?.id ?? "";
}

export function chatPickerEntryInstance(entry?: ChatPickerEntry): CanonicalProviderInstanceDescriptor | undefined {
  return entry?.instances.find(instance => instance.availability === "available")
    ?? entry?.instances.find(instance => canonicalProviderFundingState(instance) === "credit_reserved")
    ?? entry?.instances[0];
}

export interface ChatPickerModelRow {
  instanceId: string;
  modelId: string;
  modelLabel: string;
  modelAvailability: CanonicalProviderInstanceDescriptor["models"][number]["availability"];
  harnessLabel: string;
  connectionLabel?: string;
  driverKind: CanonicalProviderDriverKind;
  /** Only an existing executable choice may be selected. Discovery is display-only. */
  choice?: CanonicalProviderChoice;
}

export function deriveChatPickerModelRows(
  catalog: CanonicalProviderCatalog,
  choices: readonly CanonicalProviderChoice[],
): ChatPickerModelRow[] {
  return orderCanonicalProviderInstancesForDefault(catalog.instances.filter(instance => !isLegacyMatrixSdkProvider(instance))).flatMap(instance => instance.models.flatMap(model => {
    const choice = instance.availability === "available" && model.availability === "available"
      ? choices.find(candidate => candidate.instanceId === instance.id && candidate.modelId === model.id)
      : undefined;
    const managed = instance.id === "matrix_pi_default" && instance.driverKind === "matrix_pi";
    // Retain prior executable-only discovery for other harnesses.
    if (!choice && !managed) return [];
    return [{
      instanceId: instance.id, modelId: model.id, modelLabel: model.displayName, modelAvailability: model.availability,
      harnessLabel: managed ? "Matrix AI" : choice?.harnessLabel ?? instance.displayName,
      connectionLabel: instance.connectionLabel, driverKind: instance.driverKind,
      ...(choice ? { choice } : {}),
    }];
  }));
}

export function chatPickerModelAvailabilityLabel(row: ChatPickerModelRow, instance?: CanonicalProviderInstanceDescriptor): string {
  if (!instance) return "Access not verified";
  if (instance.availability === "available" && row.modelAvailability !== "available") return "Model unavailable";
  return canonicalProviderAvailabilityLabel(instance);
}
