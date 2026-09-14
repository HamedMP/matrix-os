import type {
  CanonicalProviderCatalog,
  CanonicalProviderDriverKind,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderOptionDescriptor,
} from "@matrix-os/contracts";

export interface CanonicalProviderChoice {
  instanceId: string;
  driverKind: CanonicalProviderDriverKind;
  harnessLabel: string;
  modelId: string;
  modelLabel: string;
  interactionMode: string;
  interactionModes: string[];
  permissionMode: string;
  permissionModes: string[];
  options: CanonicalProviderOptionDescriptor[];
  selectedOptions: Array<{ id: string; value: string | boolean }>;
  supportsFileAttachments: boolean;
}

function defaultOptionValue(
  option: CanonicalProviderOptionDescriptor,
): string | boolean | undefined {
  if (option.defaultValue !== undefined) return option.defaultValue;
  if (option.kind === "boolean") return false;
  return option.values?.[0]?.value;
}

function selectedOptionsFor(
  instance: CanonicalProviderInstanceDescriptor,
  modelId: string,
): CanonicalProviderChoice["selectedOptions"] {
  const defaults = instance.defaultSelection?.model === modelId
    ? instance.defaultSelection.options ?? []
    : [];
  return instance.options.flatMap((descriptor) => {
    const selected = defaults.find((option) => option.id === descriptor.id)?.value;
    const value = selected ?? defaultOptionValue(descriptor);
    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
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

export function canonicalProviderAvailabilityLabel(
  instance: CanonicalProviderInstanceDescriptor,
): string {
  if (instance.availability === "available") return "Available";
  if (instance.unavailabilityReason) return UNAVAILABLE_LABELS[instance.unavailabilityReason];
  if (instance.availability === "setup_required") return "Setup required";
  if (instance.availability === "auth_required") return "Authentication required";
  return "Unavailable";
}

export function deriveCanonicalProviderChoices(
  catalog: CanonicalProviderCatalog,
): CanonicalProviderChoice[] {
  return catalog.instances.flatMap((instance) => {
    if (instance.availability !== "available") return [];
    const interactionMode = instance.supports.interactionModes[0];
    const permissionMode = instance.supports.permissionModes[0];
    if (!interactionMode || !permissionMode) return [];
    return instance.models.flatMap((model) => model.availability === "available" ? [{
      instanceId: instance.id,
      driverKind: instance.driverKind,
      harnessLabel: instance.displayName,
      modelId: model.id,
      modelLabel: model.displayName,
      interactionMode,
      interactionModes: [...instance.supports.interactionModes],
      permissionMode,
      permissionModes: [...instance.supports.permissionModes],
      options: [...instance.options],
      selectedOptions: selectedOptionsFor(instance, model.id),
      supportsFileAttachments: instance.supports.attachments.some((kind) => kind === "file" || kind === "image"),
    }] : []);
  });
}
