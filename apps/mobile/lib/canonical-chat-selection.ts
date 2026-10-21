import {
  isChatgptPlanChatRoute,
  isLegacyMatrixSdkProvider,
  isMatrixAnthropicChatRoute,
  managedPiBotModelChoices,
  sameChatgptPlanSelectionBinding,
  sameMatrixAnthropicSelectionBinding,
} from "@matrix-os/contracts";
import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

type ProviderInstance = CanonicalProviderCatalog["instances"][number];

/**
 * A route a chat can be started on. The catalog also lists the routes only
 * agents run on, and the retired Matrix SDK one.
 */
export function startsChats(instance: ProviderInstance): boolean {
  return instance.supports.rootChat && !isLegacyMatrixSdkProvider(instance);
}

/** Matrix AI run through an account of the person's own: their ChatGPT subscription or their Anthropic API key. */
function ownAccountRoute(instance: ProviderInstance): "chatgpt" | "anthropic" | null {
  const route = { instanceId: instance.id, driverKind: instance.driverKind };
  if (isChatgptPlanChatRoute(route)) return "chatgpt";
  if (isMatrixAnthropicChatRoute(route)) return "anthropic";
  return null;
}

/**
 * Whether the selection names the account its route runs through now. The
 * computer refuses a turn on an own-account route whose selection names no
 * account, or one since replaced. Every other route has no account to name.
 */
export function selectionBindingCurrent(instance: ProviderInstance, selection: CanonicalChatModelSelection): boolean {
  const current = instance.defaultSelection?.options;
  const route = ownAccountRoute(instance);
  if (route === "chatgpt") return sameChatgptPlanSelectionBinding(selection.options, current);
  if (route === "anthropic") return sameMatrixAnthropicSelectionBinding(selection.options, current);
  return true;
}

/**
 * The selection of one of an engine's models, with the value the engine names
 * for each of its options: the default selection's for that model, else the
 * option's own default. On an own-account route these name the account.
 */
export function catalogSelection(instance: ProviderInstance, modelId: string): CanonicalChatModelSelection {
  const preset = instance.defaultSelection?.model === modelId ? instance.defaultSelection.options ?? [] : [];
  const options = instance.options.flatMap((option) => {
    const value = preset.find((named) => named.id === option.id)?.value ?? option.defaultValue;
    return value === undefined ? [] : [{ id: option.id, value }];
  });
  return { instanceId: instance.id, model: modelId, ...(options.length > 0 ? { options } : {}) };
}

/** The first available instance's default (or first available model) selection. */
export function defaultCatalogSelection(
  catalog: CanonicalProviderCatalog | null,
): CanonicalChatModelSelection | null {
  if (!catalog) return null;
  const managedPi = managedPiBotModelChoices(catalog)[0];
  if (managedPi) return managedPi.selection;
  for (const instance of catalog.instances) {
    // A route through the person's own account is theirs to choose, never a default.
    if (!startsChats(instance) || ownAccountRoute(instance) || instance.availability !== "available") continue;
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
    || !instance.models.some((model) => model.id === selection.model && model.availability === "available")
    || !selectionBindingCurrent(instance, selection)) return null;
  const interactionMode = instance.supports.interactionModes.includes("default")
    ? "default"
    : instance.supports.interactionModes[0];
  const permissionMode = instance.supports.permissionModes.includes("supervised")
    ? "supervised"
    : instance.supports.permissionModes[0];
  if (!interactionMode || !permissionMode) return null;
  return { interactionMode, permissionMode };
}
