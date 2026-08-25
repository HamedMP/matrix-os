import type {
  CanonicalChatSummary,
  CanonicalProviderCatalog,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderOptionDescriptor,
} from "@matrix-os/contracts";

export interface CanonicalComposerSelection {
  instanceId: string;
  model: string;
  options: Array<{ id: string; value: string | boolean }>;
  interactionMode: string;
  permissionMode: string;
}

export interface CanonicalSlashEntry {
  id: string;
  kind: "skill" | "command";
  displayName: string;
  description: string;
  invocation: string;
}

function defaultOptionValue(
  option: CanonicalProviderOptionDescriptor,
): string | boolean | undefined {
  if (option.defaultValue !== undefined) return option.defaultValue;
  if (option.kind === "boolean") return false;
  return option.values?.[0]?.value;
}

function optionsForInstance(
  instance: CanonicalProviderInstanceDescriptor,
  selected: ReadonlyArray<{ id: string; value: string | boolean }> = [],
): CanonicalComposerSelection["options"] {
  return instance.options.flatMap((descriptor) => {
    const existing = selected.find((option) => option.id === descriptor.id)?.value;
    const value = existing ?? defaultOptionValue(descriptor);
    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
}

function selectionForInstance(
  instance: CanonicalProviderInstanceDescriptor,
): CanonicalComposerSelection | null {
  if (instance.availability !== "available") return null;
  const availableModel = instance.defaultSelection
    ? instance.models.find((model) => (
        model.id === instance.defaultSelection?.model && model.availability === "available"
      ))
    : instance.models.find((model) => model.availability === "available");
  if (!availableModel) return null;
  return {
    instanceId: instance.id,
    model: availableModel.id,
    options: optionsForInstance(instance, instance.defaultSelection?.options),
    interactionMode: instance.supports.interactionModes[0] ?? "default",
    permissionMode: instance.supports.permissionModes[0] ?? "supervised",
  };
}

export function createCanonicalComposerSelection(
  catalog: CanonicalProviderCatalog,
  preferredInstanceId?: string,
): CanonicalComposerSelection | null {
  const preferred = preferredInstanceId
    ? catalog.instances.find((instance) => instance.id === preferredInstanceId)
    : undefined;
  const preferredSelection = preferred ? selectionForInstance(preferred) : null;
  if (preferredSelection) return preferredSelection;
  for (const instance of catalog.instances) {
    const selection = selectionForInstance(instance);
    if (selection) return selection;
  }
  return null;
}

export function changeCanonicalComposerInstance(
  catalog: CanonicalProviderCatalog,
  current: CanonicalComposerSelection,
  instanceId: string,
): CanonicalComposerSelection {
  const instance = catalog.instances.find((candidate) => candidate.id === instanceId);
  return (instance ? selectionForInstance(instance) : null) ?? current;
}

export function updateCanonicalComposerOption(
  catalog: CanonicalProviderCatalog,
  current: CanonicalComposerSelection,
  optionId: string,
  value: string | boolean,
): CanonicalComposerSelection {
  const instance = catalog.instances.find((candidate) => candidate.id === current.instanceId);
  const descriptor = instance?.options.find((option) => option.id === optionId);
  if (!descriptor) return current;
  const valid = descriptor.kind === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string" && descriptor.values?.some((candidate) => candidate.value === value);
  if (!valid) return current;
  return {
    ...current,
    options: current.options.map((option) => (
      option.id === optionId ? { id: option.id, value } : option
    )),
  };
}

export function listCanonicalSlashEntries(
  instance: CanonicalProviderInstanceDescriptor | undefined,
): CanonicalSlashEntry[] {
  if (!instance) return [];
  return [
    ...instance.skills.map((entry) => ({ ...entry, kind: "skill" as const })),
    ...instance.commands.map((entry) => ({ ...entry, kind: "command" as const })),
  ];
}

export function providerInstanceIsLocked(chat: CanonicalChatSummary | undefined): boolean {
  return chat?.providerBinding !== undefined;
}
