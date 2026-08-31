import type { CanonicalChatSummary, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyCanonicalComposerPreference,
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "./canonical-composer-state";
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
    initializeImmediately ? createCanonicalComposerSelection(catalog) : null
  ));
  const providerPreferencesHydrated = useProviderPreferences((state) => state.hydrated);
  const setComposerSelection = useProviderPreferences((state) => state.setComposerSelection);
  const composerSelectionTouched = useRef(false);
  const selectionChatId = useRef<string | null>(null);

  useEffect(() => {
    void useProviderPreferences.getState().hydrate();
  }, []);

  useEffect(() => {
    const chatChanged = selectionChatId.current !== chatId;
    if (chatChanged) {
      selectionChatId.current = chatId;
      composerSelectionTouched.current = false;
    }
    setSelection((current) => {
      if (!catalogReady) return null;
      const currentInstance = catalog.instances.find((instance) => instance.id === current?.instanceId);
      const requiredInstance = boundInstanceId
        ? catalog.instances.find((instance) => instance.id === boundInstanceId)
        : currentInstance;
      const next = requiredInstance
        ? createCanonicalComposerSelection(catalog, requiredInstance.id)
        : createCanonicalComposerSelection(catalog);
      if (!next) return null;
      const currentIsSupported = current && currentInstance
        && currentInstance.models.some((model) => (
          model.id === current.model && model.availability === "available"
        ))
        && currentInstance.supports.permissionModes.includes(current.permissionMode)
        && rememberedOptions(catalog, current).length === current.options.length;
      if (!chatChanged && composerSelectionTouched.current && currentIsSupported) return current;
      const preferred = applyCanonicalComposerPreference(
        catalog,
        next,
        useProviderPreferences.getState().composerSelections[next.instanceId],
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
  }, [boundInstanceId, catalog, catalogReady, chatId, currentSelection, providerPreferencesHydrated]);

  const onSelectionChange = useCallback((nextSelection: CanonicalComposerSelection) => {
    composerSelectionTouched.current = true;
    setComposerSelection(nextSelection);
    setSelection(nextSelection);
  }, [setComposerSelection]);

  return { selection, onSelectionChange };
}
