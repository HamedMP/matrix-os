import type { CanonicalProviderCatalog, CanonicalProviderInstanceDescriptor } from "#canonical-chat-provider";
import type { CanonicalChatModelSelection } from "#canonical-chat";

export const MATRIX_PI_CHAT_INSTANCE_ID = "matrix_pi_default";

export function isManagedPiBotRoute(route: { instanceId: string; driverKind: string; connectionLabel?: string }): boolean {
  return route.instanceId === MATRIX_PI_CHAT_INSTANCE_ID && route.driverKind === "matrix_pi" && route.connectionLabel === "Matrix AI";
}

/** Discovery reflects the authenticated catalog; it never acquires credentials or admits a run. */
export function managedPiBotModelChoices(catalog?: CanonicalProviderCatalog | null): Array<{ label: string; selection: CanonicalChatModelSelection }> {
  return catalog?.instances.flatMap((instance) => isManagedPiBotRoute({ instanceId: instance.id, ...instance })
    && instance.availability === "available"
    ? instance.models.flatMap((model) => model.availability === "available"
      ? [{ label: `${model.displayName} · Matrix AI · Pi`, selection: { instanceId: instance.id, model: model.id } }] : []) : []) ?? [];
}

export function botModelRoutingLabel(selection: CanonicalChatModelSelection | null | undefined,
  catalog?: CanonicalProviderCatalog | null): string {
  if (selection === undefined) return "Checking bot model…";
  if (selection?.instanceId !== MATRIX_PI_CHAT_INSTANCE_ID) return "Model routing: automatic";
  const instance = catalog?.instances.find((candidate) => candidate.id === selection.instanceId);
  const model = instance?.models.find((candidate) => candidate.id === selection.model);
  const unavailable = catalog && (instance?.availability !== "available" || model?.availability !== "available");
  return `Matrix AI · ${model?.displayName ?? selection.model}${unavailable ? " · unavailable" : ""}`;
}

const UNAVAILABLE_LABELS: Record<
  NonNullable<CanonicalProviderInstanceDescriptor["unavailabilityReason"]>,
  string
> = {
  disabled_in_settings: "Disabled in Settings",
  settings_unavailable: "Settings unavailable",
  runtime_not_runnable: "Not supported in this runtime",
  runtime_inactive: "Runtime inactive",
  runtime_unavailable: "Runtime unavailable",
  not_installed: "Not installed",
  authentication_required: "Authentication required",
  multiple_profiles_unsupported: "Choose one enabled account",
};

export function canonicalProviderAvailabilityReasonLabel(
  instance: CanonicalProviderInstanceDescriptor,
): string {
  if (instance.unavailabilityReason !== "disabled_in_settings" && instance.unavailabilityReason !== "settings_unavailable") {
    if (instance.connectionState === "credit_required") return "Matrix AI credit required";
    if (instance.connectionState === "unavailable") return "Matrix AI unavailable";
  }
  if (instance.availability === "available") return "Available";
  if (instance.unavailabilityReason) return UNAVAILABLE_LABELS[instance.unavailabilityReason];
  if (instance.availability === "setup_required") return "Setup required";
  if (instance.availability === "auth_required") return "Authentication required";
  return "Unavailable";
}
/** Keep equally named models distinguishable using server-projected route labels. */
export function canonicalProviderModelRouteLabel(instance: CanonicalProviderInstanceDescriptor | undefined,
  modelLabel: string): string {
  if (!instance) return modelLabel;
  return [modelLabel, instance.connectionLabel,
    instance.driverKind === "matrix_pi" ? "Pi" : instance.displayName].filter(Boolean).join(" · ");
}
