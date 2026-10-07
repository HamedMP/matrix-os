import { canonicalProviderAvailabilityReasonLabel, canonicalProviderFundingState, canonicalProviderModelRouteLabel,
  isManagedPiBotRoute, type CanonicalProviderCatalog } from "@matrix-os/contracts";

/** Display-only server descriptors. Executable choices still use managedPiBotModelChoices. */
export function blockedNativeBotModelRows(catalog?: CanonicalProviderCatalog | null) {
  return catalog?.instances.flatMap(instance => isManagedPiBotRoute({ instanceId: instance.id, ...instance })
    ? instance.models.flatMap(model => instance.availability !== "available" || model.availability !== "available"
      ? [{ instanceId: instance.id, modelId: model.id,
        label: `${canonicalProviderModelRouteLabel(instance, model.displayName)} · ${instance.availability === "available"
          ? "Model unavailable" : canonicalProviderFundingState(instance) === "credit_reserved" ? "Credit reserved" : canonicalProviderAvailabilityReasonLabel(instance).toLocaleLowerCase()}`,
        creditReserved: instance.availability !== "available" && canonicalProviderFundingState(instance) === "credit_reserved" }]
      : []) : []) ?? [];
}
