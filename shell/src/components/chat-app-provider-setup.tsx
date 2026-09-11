"use client";

import { useEffect, useState } from "react";
import {
  CanonicalProviderCatalogSchema,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
  type CanonicalProviderInstanceDescriptor,
  type CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import {
  canonicalProviderAvailabilityLabel,
  deriveCanonicalProviderChoices,
  type CanonicalProviderChoice,
} from "@matrix-os/ui";
import { getGatewayUrl } from "@/lib/gateway";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";
import { CheckIcon, CalendarIcon, GithubIcon, MailIcon, MessageSquareIcon } from "@/lib/hugeicons";

const PROVIDER_SELECTION_STORAGE_KEY = "matrix:canonical-chat-provider-selection";
const CHANNEL_OPTIONS = [
  { id: "shell", label: "Shell", icon: MessageSquareIcon },
  { id: "email", label: "Email", icon: MailIcon },
  { id: "calendar", label: "Calendar", icon: CalendarIcon },
  { id: "github", label: "GitHub", icon: GithubIcon },
];

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

export function useChatProviderState(boundSelection?: CanonicalChatModelSelection) {
  const [catalog, setCatalog] = useState<CanonicalProviderCatalog | null>(null);
  const [savedChoice, setSavedChoice] = useState(readSavedChoice);
  const [boundDraft, setBoundDraft] = useState<{
    bindingKey: string;
    selection: SavedProviderSelection;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    let pending = false;
    const refresh = async () => {
      if (refreshing) {
        pending = true;
        return;
      }
      refreshing = true;
      do {
        pending = false;
        try {
          const response = await fetch(`${getGatewayUrl()}/api/chat-providers?refresh=true`, {
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error("ProviderCatalogUnavailable");
          const value = CanonicalProviderCatalogSchema.parse(await response.json());
          if (!cancelled) {
            setCatalog(value);
            setUnavailable(false);
          }
        } catch (error: unknown) {
          console.warn("[chat] Canonical Provider catalog unavailable:", error instanceof Error ? error.name : "UnknownError");
          if (!cancelled) setUnavailable(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      } while (!cancelled && pending);
      refreshing = false;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      window.removeEventListener(PROVIDER_SETTINGS_CHANGED_EVENT, refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const choices = catalog ? deriveCanonicalProviderChoices(catalog) : [];
  const bindingKey = boundSelection
    ? `${boundSelection.instanceId}:${boundSelection.model}:${JSON.stringify(boundSelection.options ?? [])}`
    : "";
  const effectiveSaved = boundSelection
    ? boundDraft?.bindingKey === bindingKey
      ? boundDraft.selection
      : { key: `${boundSelection.instanceId}:${boundSelection.model}`, options: boundSelection.options ?? [] }
    : savedChoice;
  const boundChoice = choices.find((choice) => choice.instanceId === boundSelection?.instanceId
    && choiceKey(choice) === effectiveSaved.key)
    ?? choices.find((choice) => choice.instanceId === boundSelection?.instanceId
      && choice.modelId === boundSelection.model);
  const selectedBase = boundSelection
    ? boundChoice ?? null
    : choices.find((choice) => choiceKey(choice) === effectiveSaved.key)
    ?? choices.find((choice) => {
      const instance = catalog?.instances.find((candidate) => candidate.id === choice.instanceId);
      return instance?.defaultSelection?.model === choice.modelId;
    })
    ?? choices[0]
    ?? null;
  const selected = selectedBase
    ? applySavedSelection(selectedBase, effectiveSaved)
    : null;

  const save = (next: SavedProviderSelection) => {
    if (boundSelection) {
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
    if (boundSelection && choice.instanceId !== boundSelection.instanceId) return;
    const preserveControls = selected?.instanceId === choice.instanceId;
    save({
      key: choiceKey(choice),
      interactionMode: preserveControls ? selected.interactionMode : choice.interactionMode,
      permissionMode: preserveControls ? selected.permissionMode : choice.permissionMode,
      options: preserveControls ? selected.selectedOptions : choice.selectedOptions,
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

  const activeInstance = catalog?.instances.find((instance) => instance.id === selected?.instanceId) ?? null;
  return {
    catalog,
    choices,
    selected,
    select,
    selectInteractionMode,
    selectPermissionMode,
    selectOption,
    loading,
    unavailable,
    activeInstance,
  };
}

function modeLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

export function ChatProviderSetupPanel({
  catalog,
  choices,
  selected,
  onSelect,
  onInteractionModeChange,
  onPermissionModeChange,
  onOptionChange,
  onSetupAction,
  lockedInstanceId,
  showChannels,
  channels,
  onToggleChannel,
}: {
  catalog: CanonicalProviderCatalog | null;
  choices: CanonicalProviderChoice[];
  selected: CanonicalProviderChoice | null;
  onSelect: (choice: CanonicalProviderChoice) => void;
  onInteractionModeChange: (mode: string) => void;
  onPermissionModeChange: (mode: string) => void;
  onOptionChange: (id: string, value: string | boolean) => void;
  onSetupAction: (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => void;
  lockedInstanceId?: string;
  showChannels: boolean;
  channels: Set<string>;
  onToggleChannel: (channel: string) => void;
}) {
  return (
    <section className="border-b border-border/30 bg-muted/30 px-3 py-3">
      <div className="mx-auto grid w-full max-w-[720px] gap-3 md:grid-cols-[1fr_1.1fr]">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Harness and model</p>
          <div className="space-y-1.5">
            {choices.map((choice) => {
              const isSelected = choice.instanceId === selected?.instanceId && choice.modelId === selected.modelId;
              const locked = lockedInstanceId !== undefined && choice.instanceId !== lockedInstanceId;
              return (
                <button
                  key={`${choice.instanceId}:${choice.modelId}`}
                  type="button"
                  aria-label={`${choice.modelLabel} via ${choice.harnessLabel}`}
                  aria-disabled={locked}
                  disabled={locked}
                  onClick={() => onSelect(choice)}
                  className={`flex min-h-11 w-full items-center justify-between rounded-md border px-2.5 text-left text-xs transition ${isSelected ? "border-primary/35 bg-primary/10 text-foreground" : "border-border/50 bg-background/55 text-muted-foreground hover:text-foreground"}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{choice.modelLabel}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{choice.harnessLabel}</span>
                  </span>
                  {isSelected && <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              );
            })}
            {catalog?.instances.filter((instance) => instance.availability !== "available").map((instance) => (
              <div key={instance.id} className="rounded-md border border-border/40 px-2.5 py-2 text-xs text-muted-foreground">
                <p>{instance.displayName} — {canonicalProviderAvailabilityLabel(instance)}</p>
                {instance.setupActions.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {instance.setupActions.map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        className="min-h-9 rounded-md border border-border/50 bg-background px-2 text-xs font-medium text-foreground"
                        onClick={() => onSetupAction(instance, action)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {choices.length === 0 && (
              <p className="rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
                Connect a harness in Settings to start chatting.
              </p>
            )}
          </div>
          {selected ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Interaction mode
                <select
                  aria-label="Interaction mode"
                  value={selected.interactionMode}
                  onChange={(event) => onInteractionModeChange(event.target.value)}
                  className="min-h-10 rounded-md border border-border/50 bg-background px-2 text-xs font-normal normal-case tracking-normal text-foreground"
                >
                  {selected.interactionModes.map((mode) => <option key={mode} value={mode}>{modeLabel(mode)}</option>)}
                </select>
              </label>
              <label className="grid gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Permission mode
                <select
                  aria-label="Permission mode"
                  value={selected.permissionMode}
                  onChange={(event) => onPermissionModeChange(event.target.value)}
                  className="min-h-10 rounded-md border border-border/50 bg-background px-2 text-xs font-normal normal-case tracking-normal text-foreground"
                >
                  {selected.permissionModes.map((mode) => <option key={mode} value={mode}>{modeLabel(mode)}</option>)}
                </select>
              </label>
              {selected.options.map((option) => option.kind === "enum" ? (
                <label key={option.id} className="grid gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {option.label}
                  <select
                    aria-label={option.label}
                    value={String(selected.selectedOptions.find((value) => value.id === option.id)?.value ?? "")}
                    onChange={(event) => onOptionChange(option.id, event.target.value)}
                    className="min-h-10 rounded-md border border-border/50 bg-background px-2 text-xs font-normal normal-case tracking-normal text-foreground"
                  >
                    {(option.values ?? []).map((value) => <option key={value.value} value={value.value}>{value.label}</option>)}
                  </select>
                </label>
              ) : (
                <label key={option.id} className="flex min-h-10 items-center gap-2 self-end rounded-md border border-border/50 bg-background px-2 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    aria-label={option.label}
                    checked={selected.selectedOptions.find((value) => value.id === option.id)?.value === true}
                    onChange={(event) => onOptionChange(option.id, event.target.checked)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        {showChannels ? <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Channels</p>
          <div className="grid grid-cols-2 gap-1.5">
            {CHANNEL_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isSelected = channels.has(option.id);
              return (
                <button key={option.id} type="button" onClick={() => onToggleChannel(option.id)} className={`flex min-h-11 items-center gap-2 rounded-md border px-2.5 text-xs transition ${isSelected ? "border-primary/35 bg-primary/10 text-foreground" : "border-border/50 bg-background/55 text-muted-foreground hover:text-foreground"}`}>
                  <Icon className="size-3.5" aria-hidden="true" />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </div> : null}
      </div>
    </section>
  );
}
