import type { CanonicalProviderCatalog, CanonicalProviderDriverKind, CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";

export interface ChatPickerEntry {
  id: string;
  label: string;
  iconKind: CanonicalProviderDriverKind;
  instances: CanonicalProviderInstanceDescriptor[];
  capabilityClass: CanonicalProviderCatalog["drivers"][number]["capabilityClass"];
}

/** Presentation groups retain real server instance IDs; Matrix AI is an access source. */
export function deriveChatPickerEntries(catalog: CanonicalProviderCatalog): ChatPickerEntry[] {
  const managed = catalog.instances.filter(instance => instance.connectionLabel === "Matrix AI"
    || (instance.driverKind === "kernel" && instance.id === "kernel_matrix_included"));
  return [{ id: "matrix-ai", label: "Matrix AI", iconKind: "kernel", instances: managed, capabilityClass: "system_agent" },
    ...catalog.drivers.flatMap(driver => catalog.instances.filter(instance => instance.driverKind === driver.kind
      && !managed.some(candidate => candidate.id === instance.id))
      .map(instance => ({ id: instance.id, label: instance.displayName, iconKind: instance.driverKind,
        instances: [instance], capabilityClass: driver.capabilityClass })))];
}

export function chatPickerEntryForSelection(entries: ChatPickerEntry[], instanceId?: string): string {
  return entries.find(entry => entry.instances.some(instance => instance.id === instanceId))?.id
    ?? entries.find(entry => entry.instances.length > 0)?.id ?? entries[0]?.id ?? "";
}
