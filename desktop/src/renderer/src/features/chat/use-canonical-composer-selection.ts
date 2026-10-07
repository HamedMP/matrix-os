import { canonicalChatSubscriptionSelectionMatches } from "@matrix-os/ui";
import { isLegacyMatrixSdkProvider, MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID } from "@matrix-os/contracts";
import type { CanonicalChatSummary, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyCanonicalComposerPreference,
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
import { useConnection } from "../../stores/connection";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useProviderPreferences } from "../settings/provider-preferences";

function rememberedOptions(
  catalog: CanonicalProviderCatalog,
  selection: CanonicalComposerSelection,
) {
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  if (!instance) return [];
  return selection.options.filter((selected) => {
    const descriptor = instance.options.find((candidate) => candidate.id === selected.id);
    if (!descriptor) return false;
    if (descriptor.kind === "boolean") return typeof selected.value === "boolean";
    return typeof selected.value === "string"
      && descriptor.values?.some((candidate) => candidate.value === selected.value) === true;
  });
}

export function useCanonicalComposerSelection({
  catalog,
  catalogReady,
  initializeImmediately,
  chatId,
  currentSelection,
  boundInstanceId,
}: {
  catalog: CanonicalProviderCatalog;
  catalogReady: boolean;
  initializeImmediately: boolean;
  chatId: string | null;
  currentSelection?: CanonicalChatSummary["currentSelection"];
  boundInstanceId?: string;
}) {
  const [selection, setSelection] = useState<CanonicalComposerSelection | null>(() => (
    initializeImmediately && !chatId && useProviderPreferences.getState().hydrated
      ? createCanonicalComposerSelection(catalog) : null
  ));
  const identityKey = useConnection(desktopProviderIdentityKey);
  const selectionIdentityKey = useRef(identityKey);
  const providerPreferencesHydrated = useProviderPreferences((state) => state.hydrated);
  const lastComposerInstanceId = useProviderPreferences((state) => state.lastComposerInstanceId);
  const setComposerSelection = useProviderPreferences((state) => state.setComposerSelection);
  const composerSelectionTouched = useRef(false);
  const selectionChatId = useRef<string | null>(null);

  useEffect(() => {
    void useProviderPreferences.getState().hydrate();
  }, []);

  useEffect(() => {
    const scopeChanged = selectionIdentityKey.current !== identityKey;
    selectionIdentityKey.current = identityKey;
    const chatChanged = selectionChatId.current !== chatId;
    if (chatChanged || scopeChanged) {
      selectionChatId.current = chatId;
      composerSelectionTouched.current = false;
    }
    setSelection((current) => {
      if (!catalogReady) return null;
      // A cold read may restore an explicit personal source. Do not expose a
      // runnable replacement default before that intent is known. The user can
      // still choose a current route while preferences are loading.
      if (!chatId && !providerPreferencesHydrated && !composerSelectionTouched.current) return null;
      const currentInstance = catalog.instances.find((instance) => instance.id === current?.instanceId);
      const selectedChatInstance = currentSelection
        ? catalog.instances.find((instance) => instance.id === currentSelection.instanceId)
        : undefined;
      const rememberedInstance = lastComposerInstanceId
        ? catalog.instances.find((instance) => instance.id === lastComposerInstanceId)
        : undefined;
      const requiredInstance = boundInstanceId
        ? catalog.instances.find((instance) => instance.id === boundInstanceId)
        : chatId
          ? selectedChatInstance ?? currentInstance
          : rememberedInstance ?? currentInstance;
      const currentIsSupported = current && currentInstance?.availability === "available" && !isLegacyMatrixSdkProvider(currentInstance)
        && (!boundInstanceId || current.instanceId === boundInstanceId)
        && currentInstance.models.some((model) => (
          model.id === current.model && model.availability === "available"
        ))
        && currentInstance.supports.permissionModes.includes(current.permissionMode)
        && rememberedOptions(catalog, current).length === current.options.length
        && canonicalChatSubscriptionSelectionMatches(currentInstance, current.options);
      if (!chatChanged && !scopeChanged && composerSelectionTouched.current && currentIsSupported) return current;
      if (!chatChanged && !scopeChanged && composerSelectionTouched.current && current
        && current.instanceId === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID
        && (!boundInstanceId || current.instanceId === boundInstanceId)
        && (!currentInstance || currentInstance.availability !== "available"
          || !canonicalChatSubscriptionSelectionMatches(currentInstance, current.options)
          || !currentInstance.models.some(model => model.id === current.model && model.availability === "available"))) return current;
      // Existing Chats retain their saved route even when it cannot run. Choosing
      // a global default here would silently change the harness/account.
      if (chatId && currentSelection && (!requiredInstance
        || isLegacyMatrixSdkProvider(requiredInstance)
        || requiredInstance.availability !== "available"
        || !canonicalChatSubscriptionSelectionMatches(requiredInstance, currentSelection.options)
        || !requiredInstance.models.some((model) => model.id === currentSelection.model && model.availability === "available"))) {
        return {
          instanceId: boundInstanceId ?? currentSelection.instanceId,
          model: currentSelection.model,
          options: currentSelection.options ?? [],
          interactionMode: current?.interactionMode ?? "default",
          permissionMode: current?.permissionMode ?? "supervised",
        };
      }
      // A remembered personal model is explicit intent too. Restore its exact
      // binding as unavailable instead of selecting a newly observed default.
      if (!chatId && lastComposerInstanceId === MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID
        && (!boundInstanceId || boundInstanceId === lastComposerInstanceId)) {
        const remembered = useProviderPreferences.getState().composerSelections[lastComposerInstanceId];
        if (!remembered?.model) return null;
        if (!rememberedInstance || rememberedInstance.availability !== "available"
          || !canonicalChatSubscriptionSelectionMatches(rememberedInstance, remembered.options)
          || !rememberedInstance.models.some(model => model.id === remembered.model && model.availability === "available")) {
          return {
            instanceId: lastComposerInstanceId,
            model: remembered.model,
            options: remembered.options,
            interactionMode: "default",
            permissionMode: remembered.permissionMode,
          };
        }
      }
      const next = requiredInstance
        ? createCanonicalComposerSelection(catalog, requiredInstance.id)
        : createCanonicalComposerSelection(catalog);
      if (!next || (chatId && boundInstanceId && next.instanceId !== boundInstanceId)) return null;
      const preference = useProviderPreferences.getState().composerSelections[next.instanceId];
      if (!chatId && preference && requiredInstance
        && !canonicalChatSubscriptionSelectionMatches(requiredInstance, preference.options)) return null;
      const preferred = applyCanonicalComposerPreference(
        catalog,
        next,
        preference,
      );
      const rememberedModel = currentSelection && currentSelection.instanceId === preferred.instanceId
        ? requiredInstance?.models.find((model) => (
            model.id === currentSelection.model && model.availability === "available"
          ))
        : undefined;
      return currentSelection && rememberedModel
        ? {
            ...preferred,
            model: currentSelection.model,
            options: rememberedOptions(catalog, {
              ...preferred,
              options: currentSelection.options ?? preferred.options,
            }),
          }
        : preferred;
    });
  }, [
    boundInstanceId,
    identityKey,
    catalog,
    catalogReady,
    chatId,
    currentSelection,
    lastComposerInstanceId,
    providerPreferencesHydrated,
  ]);

  const onSelectionChange = useCallback((nextSelection: CanonicalComposerSelection) => {
    composerSelectionTouched.current = true;
    setComposerSelection(nextSelection);
    setSelection(nextSelection);
  }, [setComposerSelection]);

  return { selection, onSelectionChange };
}
