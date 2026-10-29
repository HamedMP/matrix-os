"use client";

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
} from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";

// Stable markup identity preserves a pressed SVG across catalog refreshes.
const MATRIX_RABBIT_HTML = { __html: rabbitMarkSvg("matrix-chat-rabbit-mark") };

const PROVIDER_SELECTION_STORAGE_KEY = "matrix:canonical-chat-provider-selection";
function choiceKey(choice: Pick<CanonicalProviderChoice, "instanceId" | "modelId">): string {
  return `${choice.instanceId}:${choice.modelId}`;
}

interface SavedProviderSelection {
  key: string;
  interactionMode?: string;
  permissionMode?: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

function readSavedChoice(): SavedProviderSelection {
  if (typeof window === "undefined") return { key: "" };
  const value = window.localStorage.getItem(PROVIDER_SELECTION_STORAGE_KEY);
  if (typeof value !== "string" || value.length > 4_096) return { key: "" };
  // Keep accepting the old instance:model value while migrating saved choices.
  if (!value.startsWith("{")) return { key: value.slice(0, 320) };
  try {
    const parsed = JSON.parse(value) as Partial<SavedProviderSelection>;
    if (typeof parsed.key !== "string" || parsed.key.length > 320) return { key: "" };
    return {
      key: parsed.key,
      ...(typeof parsed.interactionMode === "string" && parsed.interactionMode.length <= 80
        ? { interactionMode: parsed.interactionMode }
        : {}),
      ...(typeof parsed.permissionMode === "string" && parsed.permissionMode.length <= 80
        ? { permissionMode: parsed.permissionMode }
        : {}),
      ...(Array.isArray(parsed.options) ? {
        options: parsed.options.slice(0, 32).flatMap((option) => (
          option && typeof option.id === "string" && option.id.length <= 80
          && (typeof option.value === "boolean" || (typeof option.value === "string" && option.value.length <= 160))
            ? [{ id: option.id, value: option.value }]
            : []
        )),
      } : {}),
    };
  } catch (error: unknown) {
    console.warn("[chat] Ignoring invalid saved Provider selection:", error instanceof Error ? error.name : "UnknownError");
    return { key: "" };
  }
}

function applySavedSelection(
  choice: CanonicalProviderChoice,
  saved: SavedProviderSelection,
): CanonicalProviderChoice {
  const interactionMode = saved.interactionMode && choice.interactionModes.includes(saved.interactionMode)
    ? saved.interactionMode
    : choice.interactionMode;
  const permissionMode = saved.permissionMode && choice.permissionModes.includes(saved.permissionMode)
    ? saved.permissionMode
    : choice.permissionMode;
  const requestedOptions = saved.options ?? [];
  const selectedOptions = choice.options.flatMap((descriptor) => {
    const requested = requestedOptions.find((option) => option.id === descriptor.id)?.value;
    const valid = descriptor.kind === "boolean"
      ? typeof requested === "boolean"
      : typeof requested === "string" && descriptor.values?.some((value) => value.value === requested);
    const fallback = choice.selectedOptions.find((option) => option.id === descriptor.id)?.value;
    const value = valid ? requested : fallback;
    return value === undefined ? [] : [{ id: descriptor.id, value }];
  });
  return { ...choice, interactionMode, permissionMode, selectedOptions };
}

export function useChatProviderState(
  currentSelection?: CanonicalChatModelSelection,
  boundInstanceId?: string,
  context?: { chatId?: string; scopeKey?: string; executionControls?: CanonicalChatExecutionControls },
) {
  const [catalog, setCatalog] = useState<CanonicalProviderCatalog | null>(null);
  const [savedChoice, setSavedChoice] = useState(readSavedChoice);
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
    let cancelled = false;
    let refreshing = false;
    let hasCatalog = false;
    let authorityGeneration = 0;
    let authoritySuspended = false;
    let pending = false;
    let forcePending = false;
    const refresh = async (force = false) => {
      forcePending = forcePending || force;
      if (refreshing) {
        // Focus/visibility belong to the read already in progress. Only an
        // explicit post-change refresh must queue a newer observation.
        pending = pending || force;
        return;
      }
      refreshing = true;
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
          if (!cancelled) {
            hasCatalog = true;
            setCatalog(value);
            setUnavailable(false);
            setLoading(false);
            if (requestAuthorityGeneration === authorityGeneration && (!authoritySuspended || forceRefresh)) {
              authoritySuspended = false;
              setHasTrustedCatalog(true);
            }
          }
        } catch (error: unknown) {
          console.warn("[chat] Canonical Provider catalog unavailable:", error instanceof Error ? error.name : "UnknownError");
          if (!cancelled) setUnavailable(true);
        }
      } while (!cancelled && pending);
      refreshing = false;
      if (!cancelled) setLoading(false);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const onFocus = () => { void refresh(); };
    const onSettingsChange = () => {
      authorityGeneration += 1;
      authoritySuspended = true;
      setHasTrustedCatalog(false);
      void refresh(true);
    };
    refreshRef.current = () => { void refresh(true); };
    void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, onSettingsChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      refreshRef.current = () => undefined;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, onSettingsChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const choices = catalog ? deriveCanonicalProviderChoices(catalog).filter(choice => catalog.instances.some(instance => instance.id === choice.instanceId && instance.supports.rootChat)
    && (!unavailable || !(isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice)))) : [];
  const bindingKey = currentSelection
    ? JSON.stringify([context?.scopeKey ?? "", context?.chatId ?? "", currentSelection, context?.executionControls?.runId ?? ""])
    : "";
  const restoredModes = context?.executionControls?.chatId === context?.chatId
    ? canonicalChatTurnModes(catalog, currentSelection, context?.executionControls) : null;
  const effectiveSaved = currentSelection
    ? boundDraft?.bindingKey === bindingKey
      ? boundDraft.selection
      : { key: `${currentSelection.instanceId}:${currentSelection.model}`, options: currentSelection.options ?? [], ...restoredModes }
    : savedChoice;
  const personalInstanceId = [MATRIX_PI_CHATGPT_PLAN_INSTANCE_ID, MATRIX_PI_ANTHROPIC_API_INSTANCE_ID]
    .find(instanceId => effectiveSaved.key.startsWith(`${instanceId}:`));
  const personalIntent = personalInstanceId
    ? { instanceId: personalInstanceId, modelId: effectiveSaved.key.slice(personalInstanceId.length + 1) } : null;
  const rememberedChoice = choices.find(choice => (!boundInstanceId || choice.instanceId === boundInstanceId) && choiceKey(choice) === effectiveSaved.key);
  const chatChoice = choices.find((choice) => (!boundInstanceId || choice.instanceId === boundInstanceId)
    && choiceKey(choice) === effectiveSaved.key)
    ?? choices.find((choice) => choice.instanceId === currentSelection?.instanceId
      && choice.modelId === currentSelection.model);
  const selectedBase = personalIntent
    ? rememberedChoice ?? null
    : currentSelection
    ? chatChoice ?? null
    : choices.find((choice) => choiceKey(choice) === effectiveSaved.key)
    ?? choices.find((choice) => {
      if (!canonicalProviderChoiceCanBeDefault(choice)) return false;
      const instance = catalog?.instances.find((candidate) => candidate.id === choice.instanceId);
      return instance?.defaultSelection?.model === choice.modelId;
    })
    ?? choices.find(canonicalProviderChoiceCanBeDefault)
    ?? null;
  const selectedInstance = catalog?.instances.find(instance => instance.id === selectedBase?.instanceId);
  const selected = selectedBase && canonicalChatSubscriptionSelectionMatches(selectedInstance, effectiveSaved.options)
    ? applySavedSelection(selectedBase, effectiveSaved)
    : null;

  const save = (next: SavedProviderSelection) => {
    if (currentSelection) {
      setBoundDraft({ bindingKey, selection: next });
      return;
    }
    setSavedChoice(next);
    try {
      window.localStorage.setItem(PROVIDER_SELECTION_STORAGE_KEY, JSON.stringify(next));
    } catch (error: unknown) {
      console.warn("[chat] Failed to save Provider selection:", error instanceof Error ? error.name : "UnknownError");
    }
  };

  const select = (choice: CanonicalProviderChoice) => {
    if (boundInstanceId && choice.instanceId !== boundInstanceId) return;
    if ((isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice)) && !choices.some(current => current.instanceId === choice.instanceId
      && current.modelId === choice.modelId
      && canonicalChatSubscriptionSelectionMatches(catalog?.instances.find(instance => instance.id === choice.instanceId), choice.selectedOptions))) return;
    const preserveControls = selected?.instanceId === choice.instanceId;
    save({
      key: choiceKey(choice),
      interactionMode: preserveControls ? selected.interactionMode : choice.interactionMode,
      permissionMode: preserveControls ? selected.permissionMode : choice.permissionMode,
      options: preserveControls && !(isChatgptPlanChatRoute(choice) || isMatrixAnthropicChatRoute(choice)) ? selected.selectedOptions : choice.selectedOptions,
    });
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
    : personalIntent ?? (currentSelection ? { instanceId: currentSelection.instanceId, modelId: currentSelection.model } : null);
  const activeInstance = catalog?.instances.find((instance) => instance.id === displaySelection?.instanceId) ?? null;
  const displayModelLabel = selected?.modelLabel
    ?? activeInstance?.models.find(model => model.id === displaySelection?.modelId)?.displayName
    ?? currentSelection?.model;
  const selectionStatus = displaySelection && !selected ? canonicalProviderUnavailableSelectionLabel(activeInstance, displaySelection.modelId) : null;
  return {
    catalog,
    choices,
    selected,
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
