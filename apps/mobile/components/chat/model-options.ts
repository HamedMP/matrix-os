import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

import { selectionCanRun } from "./model-choices";

export interface ModelOptionGroup {
  id: string;
  label: string;
  values: { value: string; label: string; selected: boolean }[];
}

/**
 * The choices an engine offers beside the model, such as reasoning effort:
 * the ones web shows in its composer. A selection that cannot run has none.
 */
export function modelOptionGroups(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null,
): ModelOptionGroup[] {
  if (!catalog || !selection || !selectionCanRun(catalog, selection)) return [];
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);

  return (instance?.options ?? []).flatMap((option) => {
    if (option.placement !== "composer" || option.kind !== "enum" || !option.values || option.values.length < 2) return [];
    // Nothing is marked when no value is saved and the engine names no default.
    const current = selection.options?.find((saved) => saved.id === option.id)?.value ?? option.defaultValue;
    return [{
      id: option.id,
      label: option.label,
      values: option.values.map(({ value, label }) => ({ value, label, selected: value === current })),
    }];
  });
}

/**
 * The selection of a newly chosen model, keeping the composer choices, such as
 * reasoning effort, made for the model it replaces on the same engine, as web
 * does. A value the engine no longer offers takes the engine's own, and so does
 * every other option, among them the account an own-account route is bound to.
 */
export function selectionKeepingOptions(
  catalog: CanonicalProviderCatalog | null,
  current: CanonicalChatModelSelection | null,
  next: CanonicalChatModelSelection,
): CanonicalChatModelSelection {
  if (!catalog || !current || current.instanceId !== next.instanceId) return next;
  const instance = catalog.instances.find((candidate) => candidate.id === next.instanceId);
  const saved = Object.fromEntries((current.options ?? []).map((option) => [option.id, option.value]));
  let kept = next;
  for (const option of instance?.options ?? []) {
    if (option.placement !== "composer" || option.kind !== "enum" || !Object.hasOwn(saved, option.id)) continue;
    const value = saved[option.id];
    if (typeof value === "string" && option.values?.some((offered) => offered.value === value)) {
      kept = selectionWithOption(kept, option.id, value);
    }
  }
  return kept;
}

export function selectionWithOption(
  selection: CanonicalChatModelSelection,
  optionId: string,
  value: string,
): CanonicalChatModelSelection {
  const others = (selection.options ?? []).filter((option) => option.id !== optionId);
  return { ...selection, options: [...others, { id: optionId, value }] };
}
