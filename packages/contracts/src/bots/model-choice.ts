import type { CanonicalProviderCatalog } from "#canonical-chat-provider";
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
