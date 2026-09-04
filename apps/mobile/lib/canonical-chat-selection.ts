import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

/** The first available instance's default (or first available model) selection. */
export function defaultCatalogSelection(
  catalog: CanonicalProviderCatalog | null,
): CanonicalChatModelSelection | null {
  if (!catalog) return null;
  for (const instance of catalog.instances) {
    if (instance.availability !== "available") continue;
    if (instance.defaultSelection) return instance.defaultSelection;
    const firstModel = instance.models.find((model) => model.availability === "available");
    if (firstModel) return { instanceId: instance.id, model: firstModel.id };
  }
  return null;
}
