import { managedPiBotModelChoices, isLegacyMatrixSdkProvider } from "@matrix-os/contracts";
import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

/** The first available instance's default (or first available model) selection. */
export function defaultCatalogSelection(
  catalog: CanonicalProviderCatalog | null,
): CanonicalChatModelSelection | null {
  if (!catalog) return null;
  const managedPi = managedPiBotModelChoices(catalog)[0];
  if (managedPi) return managedPi.selection;
  for (const instance of catalog.instances) {
    if (isLegacyMatrixSdkProvider(instance) || instance.availability !== "available") continue;
    if (instance.defaultSelection) return instance.defaultSelection;
    const firstModel = instance.models.find((model) => model.availability === "available");
    if (firstModel) return { instanceId: instance.id, model: firstModel.id };
  }
  return null;
}

/**
 * Interaction/permission mode for a turn must be one the selected instance
 * actually declares in its `supports` capabilities (validated server-side by
 * `supportsRequirements` — anything else is rejected as `capability_mismatch`).
 * The system/Hermes driver, for example, only supports `["default"]` /
 * `["full_access"]`, not the "supervised" mode coding-agent drivers use.
 */
export function defaultTurnModes(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null,
): { interactionMode: string; permissionMode: string } | null {
  if (!catalog || !selection) return null;
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  if (instance?.availability !== "available" || isLegacyMatrixSdkProvider(instance)
    || !instance.models.some((model) => model.id === selection.model && model.availability === "available")) return null;
  const interactionMode = instance.supports.interactionModes.includes("default")
    ? "default"
    : instance.supports.interactionModes[0];
  const permissionMode = instance.supports.permissionModes.includes("supervised")
    ? "supervised"
    : instance.supports.permissionModes[0];
  if (!interactionMode || !permissionMode) return null;
  return { interactionMode, permissionMode };
}
