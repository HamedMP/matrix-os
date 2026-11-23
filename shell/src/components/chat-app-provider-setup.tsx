"use client";

import { providerCatalogObservationRetryDelay } from "@matrix-os/ui";

import { useCallback, useEffect, useRef, useState } from "react";
import { rabbitMarkSvg } from "@matrix-os/brand/marks";
import {
  CanonicalProviderCatalogSchema,
  canonicalChatTurnModes,
  type CanonicalChatExecutionControls,
  FUNDED_AI_READINESS_TIMEOUTS,
  isChatgptPlanChatRoute,
  isMatrixAnthropicChatRoute,
  MATRIX_PI_ANTHROPIC_API_INSTANCE_ID,
  MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
  type CanonicalProviderDriverKind,
} from "@matrix-os/contracts";
import {
  HarnessIcon,
  deriveCanonicalProviderChoices,
  type CanonicalProviderChoice,
  canonicalChatProviderCatalogPath,
  canonicalProviderUnavailableSelectionLabel,
  canonicalChatSubscriptionSelectionMatches,
  canonicalProviderChoiceCanBeDefault,
  canonicalComposerSelectionIsAvailable,
} from "@matrix-os/ui";
import { PER_PROVIDER_KEY, PROVIDER_PREFERENCES_CHANGED_EVENT, choiceKey, readSavedChoice, applySavedSelection, readSavedProviderPreferences, rememberProviderPreference, saveLastProviderSelection, type SavedProviderSelection } from "./chat-provider-preferences";
import { getGatewayUrl } from "@/lib/gateway";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";

// Stable markup identity preserves a pressed SVG across catalog refreshes.
const MATRIX_RABBIT_HTML = { __html: rabbitMarkSvg("matrix-chat-rabbit-mark") };

export function useChatProviderState(
  currentSelection?: CanonicalChatModelSelection,
  boundInstanceId?: string,
  context?: { chatId?: string; scopeKey?: string; executionControls?: CanonicalChatExecutionControls },
) {
  const [catalog, setCatalog] = useState<CanonicalProviderCatalog | null>(null);
  const [savedChoice, setSavedChoice] = useState(readSavedChoice);
  const [providerPreferences, setProviderPreferences] = useState(readSavedProviderPreferences);
  const [boundDraft, setBoundDraft] = useState<{
    bindingKey: string;
    selection: SavedProviderSelection;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [hasTrustedCatalog, setHasTrustedCatalog] = useState(false);
  const refreshRef = useRef<() => void>(() => undefined);
  const requestRefresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    const refreshPreferences = () => setProviderPreferences(readSavedProviderPreferences());
    const onStorage = (event: StorageEvent) => {
      if (event.key === PER_PROVIDER_KEY || event.key === null) refreshPreferences();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(PROVIDER_PREFERENCES_CHANGED_EVENT, refreshPreferences);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROVIDER_PREFERENCES_CHANGED_EVENT, refreshPreferences);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    let hasCatalog = false;
    let authorityGeneration = 0;
    let authoritySuspended = false;
    let pending = false;
    let forcePending = false;
    let observationRetries = 0;
    let observedCatalog: CanonicalProviderCatalog | null = null;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const isOnline = () => navigator.onLine !== false;
    const scheduleObservationCheck = (value: CanonicalProviderCatalog) => {
      clearTimeout(observationTimer);
      if (!value.instances.some(instance => instance.observationState === "checking")) {
        observationRetries = 0;
        return;
      }
      const delay = providerCatalogObservationRetryDelay(value, observationRetries) ?? 5 * 60_000;
      observationRetries = Math.min(3, observationRetries + 1);
      if (document.visibilityState === "visible" && isOnline()) {
        observationTimer = setTimeout(() => {
          if (document.visibilityState === "visible" && isOnline()) void refresh();
        }, delay);
      }
    };
    async function refresh(force = false) {
      if (cancelled) return;
      forcePending = forcePending || force;
      if (!isOnline()) return;
      if (refreshing) {
        // Focus/visibility belong to the read already in progress. Only an
        // explicit post-change refresh must queue a newer observation.
        pending = pending || forcePending;
        return;
      }
      refreshing = true;
      clearTimeout(observationTimer);
      if (!cancelled && !hasCatalog) setLoading(true);
      do {
        pending = false;
        // Once provider settings change, every follow-up read must bypass the
        // cached catalog until one succeeds and restores trust. Otherwise a
        // normal focus read can clear the error while leaving Agents blocked
        // with neither an active request nor a retry action.
        const forceRefresh = forcePending || authoritySuspended;
        forcePending = false;
        const requestAuthorityGeneration = authorityGeneration;
        try {
          const response = await fetch(`${getGatewayUrl()}${canonicalChatProviderCatalogPath(forceRefresh)}`, {
            signal: AbortSignal.timeout(FUNDED_AI_READINESS_TIMEOUTS.rendererRequestMs),
          });
          if (!response.ok) throw new Error("ProviderCatalogUnavailable");
          const value = CanonicalProviderCatalogSchema.parse(await response.json());
          if (!cancelled && requestAuthorityGeneration === authorityGeneration) {
            clearTimeout(observationTimer);
            hasCatalog = true;
            observedCatalog = value;
            setCatalog(value);
            scheduleObservationCheck(value);
            setUnavailable(false);
            setLoading(false);
            if (requestAuthorityGeneration === authorityGeneration && (!authoritySuspended || forceRefresh)) {
              authoritySuspended = false;
              setHasTrustedCatalog(true);
            }
          }
        } catch (error: unknown) {
          console.warn("[chat] Canonical Provider catalog unavailable:", error instanceof Error ? error.name : "UnknownError");
          if (!cancelled && requestAuthorityGeneration === authorityGeneration) {
            setUnavailable(true);
            if (observedCatalog) scheduleObservationCheck(observedCatalog);
          }
        }
      } while (!cancelled && pending && isOnline());
      refreshing = false;
      if (!cancelled) setLoading(false);
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
      else clearTimeout(observationTimer);
    };
    const onFocus = () => { void refresh(); };
    const onOffline = () => { clearTimeout(observationTimer); };
    const onOnline = () => { if (document.visibilityState === "visible") void refresh(); };
    const onSettingsChange = () => {
      observationRetries = 0;
      authorityGeneration += 1;
      authoritySuspended = true;
      setHasTrustedCatalog(false);
      void refresh(true);
    };
    refreshRef.current = () => { observationRetries = 0; void refresh(true); };
    void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, onSettingsChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearTimeout(observationTimer);
      refreshRef.current = () => undefined;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, onSettingsChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const choices = catalog ? deriveCanonicalProviderChoices(catalog, { allowUnavailableManagedModels: true }).filter(choice => catalog.instances.some(instance => instance.id === choice.instanceId && instance.supports.rootChat)
    && (!unavailable || !(isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice)))) : [];
  const defaultChoice = choices.find((choice) => {
      if (!canonicalProviderChoiceCanBeDefault(choice)) return false;
      const instance = catalog?.instances.find((candidate) => candidate.id === choice.instanceId);
      return instance?.defaultSelection?.model === choice.modelId;
    })
    ?? choices.find(choice => canonicalProviderChoiceCanBeDefault(choice)
      && catalog?.instances.some(instance => instance.id === choice.instanceId && instance.availability === "available"
        && instance.models.some(model => model.id === choice.modelId && model.availability === "available")))
    ?? null;
  const bindingKey = currentSelection
    ? JSON.stringify([context?.scopeKey ?? "", context?.chatId ?? "", currentSelection, context?.executionControls?.runId ?? ""])
    : "";
  const restoredModes = context?.executionControls?.chatId === context?.chatId
    ? canonicalChatTurnModes(catalog, currentSelection, context?.executionControls) : null;
  const effectiveSaved = currentSelection
    ? boundDraft?.bindingKey === bindingKey
      ? boundDraft.selection
      : { key: `${currentSelection.instanceId}:${currentSelection.model}`, options: currentSelection.options ?? [], ...restoredModes }
    : providerPreferences[Object.keys(providerPreferences).sort((a, b) => b.length - a.length)
      .find(id => savedChoice.instanceId ? id === savedChoice.instanceId : savedChoice.key.startsWith(`${id}:`))
      ?? (!savedChoice.key ? defaultChoice?.instanceId : undefined) ?? ""] ?? savedChoice;
  const retainedInstanceId = ["matrix_pi_default", MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, MATRIX_PI_ANTHROPIC_API_INSTANCE_ID]
    .find(instanceId => effectiveSaved.key.startsWith(`${instanceId}:`));
  const checkingInstance = catalog?.instances.find(instance => instance.observationState === "checking" && effectiveSaved.key.startsWith(`${instance.id}:`));
  const retainedIntent = retainedInstanceId
    ? { instanceId: retainedInstanceId, modelId: effectiveSaved.key.slice(retainedInstanceId.length + 1) }
    : checkingInstance
      ? { instanceId: checkingInstance.id, modelId: effectiveSaved.key.slice(checkingInstance.id.length + 1) } : null;
  const rememberedChoice = choices.find(choice => (!boundInstanceId || choice.instanceId === boundInstanceId) && choiceKey(choice) === effectiveSaved.key);
  const chatChoice = choices.find((choice) => (!boundInstanceId || choice.instanceId === boundInstanceId)
    && choiceKey(choice) === effectiveSaved.key)
    ?? choices.find((choice) => choice.instanceId === currentSelection?.instanceId
      && choice.modelId === currentSelection.model);
  const selectedBase = retainedIntent
    ? rememberedChoice ?? null
    : currentSelection
    ? chatChoice ?? null
    : choices.find((choice) => choiceKey(choice) === effectiveSaved.key)
    ?? defaultChoice;
  const selectedInstance = catalog?.instances.find(instance => instance.id === selectedBase?.instanceId);
  const selected = selectedBase && canonicalChatSubscriptionSelectionMatches(selectedInstance, effectiveSaved.options)
    ? applySavedSelection(selectedBase, effectiveSaved)
    : null;

  const save = (value: SavedProviderSelection, requestedInstanceId?: string) => {
    const instanceId = requestedInstanceId ?? selected?.instanceId;
    if (!instanceId) return;
    const next = { ...value, instanceId };
    // Preserve the source too, including an untouched legacy single preference.
    const preferences = selected ? { ...providerPreferences, [selected.instanceId]: {
      key: choiceKey(selected), instanceId: selected.instanceId,
      interactionMode: selected.interactionMode, permissionMode: selected.permissionMode, options: selected.selectedOptions,
    } } : providerPreferences;
    setProviderPreferences(rememberProviderPreference(preferences, instanceId, next));
    if (currentSelection) {
      setBoundDraft({ bindingKey, selection: next });
      return;
    }
    setSavedChoice(next);
    saveLastProviderSelection(next);
  };

  const select = (choice: CanonicalProviderChoice) => {
    if (boundInstanceId && choice.instanceId !== boundInstanceId) return;
    if ((isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice)) && !choices.some(current => current.instanceId === choice.instanceId
      && current.modelId === choice.modelId
      && canonicalChatSubscriptionSelectionMatches(catalog?.instances.find(instance => instance.id === choice.instanceId), choice.selectedOptions))) return;
    const preserveControls = selected?.instanceId === choice.instanceId;
    const preference = preserveControls ? {
      key: choiceKey(choice), interactionMode: selected.interactionMode,
      permissionMode: selected.permissionMode, options: selected.selectedOptions,
    } : providerPreferences[choice.instanceId];
    const restored = preference ? applySavedSelection(choice, preference) : choice;
    save({
      key: choiceKey(choice), interactionMode: restored.interactionMode, permissionMode: restored.permissionMode,
      options: isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice) ? choice.selectedOptions : restored.selectedOptions,
    }, choice.instanceId);
  };

  const updateSelected = (patch: Partial<Omit<SavedProviderSelection, "key">>) => {
    if (!selected) return;
    save({
      key: choiceKey(selected),
      interactionMode: selected.interactionMode,
      permissionMode: selected.permissionMode,
      options: selected.selectedOptions,
      ...patch,
    });
  };

  const selectInteractionMode = (mode: string) => {
    if (selected?.interactionModes.includes(mode)) updateSelected({ interactionMode: mode });
  };
  const selectPermissionMode = (mode: string) => {
    if (selected?.permissionModes.includes(mode)) updateSelected({ permissionMode: mode });
  };
  const selectOption = (id: string, value: string | boolean) => {
    if (!selected) return;
    const descriptor = selected.options.find((option) => option.id === id);
    const valid = descriptor?.kind === "boolean"
      ? typeof value === "boolean"
      : typeof value === "string" && descriptor?.values?.some((candidate) => candidate.value === value);
    if (!valid) return;
    updateSelected({
      options: selected.selectedOptions.map((option) => option.id === id ? { id, value } : option),
    });
  };

  const displaySelection = selected ? { instanceId: selected.instanceId, modelId: selected.modelId }
    : retainedIntent ?? (currentSelection ? { instanceId: currentSelection.instanceId, modelId: currentSelection.model } : null);
  const activeInstance = catalog?.instances.find((instance) => instance.id === displaySelection?.instanceId) ?? null;
  const displayModelLabel = selected?.modelLabel
    ?? activeInstance?.models.find(model => model.id === displaySelection?.modelId)?.displayName
    ?? currentSelection?.model;
  const selectionAvailable = Boolean(catalog && selected && canonicalComposerSelectionIsAvailable(catalog, {
    instanceId: selected.instanceId, model: selected.modelId, options: selected.selectedOptions,
    interactionMode: selected.interactionMode, permissionMode: selected.permissionMode,
  }));
  const selectionStatus = displaySelection && !selectionAvailable ? canonicalProviderUnavailableSelectionLabel(activeInstance, displaySelection.modelId) : null;
  return {
    catalog,
    choices,
    selected,
    selectionAvailable,
    select,
    selectInteractionMode,
    selectPermissionMode,
    selectOption,
    loading,
    hasTrustedCatalog,
    refresh: requestRefresh,
    unavailable,
    activeInstance,
    displaySelection,
    displayModelLabel,
    selectionStatus,
  };
}

/**
 * Web Chat's glyph for a harness: the Matrix rabbit for Matrix-run routes, otherwise the harness
 * logo. `small` fits model rows, matching Electron Desktop's 13px row glyphs.
 */
export function WebProviderDriverIcon({ kind, small = false }: { kind: CanonicalProviderDriverKind; small?: boolean }) {
  return kind === "kernel" || kind === "matrix_bot" || kind === "matrix_pi" ? <span aria-hidden="true" className={`inline-flex ${small ? "size-3.5" : "size-5"} [&_svg]:size-full`}
    dangerouslySetInnerHTML={MATRIX_RABBIT_HTML} /> : (
    <span className={small
      ? "inline-flex size-3.5 shrink-0 items-center justify-center [&_.matrix-ap-agent-logo]:!size-3.5 [&_.matrix-ap-agent-logo]:!rounded-sm [&_img]:!size-2.5 [&_svg]:size-3"
      : "inline-flex size-5 shrink-0 items-center justify-center [&_.matrix-ap-agent-logo]:!size-5 [&_.matrix-ap-agent-logo]:!rounded [&_img]:!size-3 [&_svg]:size-4"}>
      <HarnessIcon harness={kind === "claude_code" ? "claude" : kind} />
    </span>
  );
}
