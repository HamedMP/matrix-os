import { CanonicalProviderInstanceIdSchema } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "@matrix-os/ui";
import { z } from "zod/v4";

const PROVIDER_SELECTION_STORAGE_KEY = "matrix:canonical-chat-provider-selection";
export function choiceKey(choice: Pick<CanonicalProviderChoice, "instanceId" | "modelId">): string {
  return `${choice.instanceId}:${choice.modelId}`;
}

export interface SavedProviderSelection {
  key: string;
  instanceId?: string;
  interactionMode?: string;
  permissionMode?: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

export function readSavedChoice(): SavedProviderSelection {
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
      ...(CanonicalProviderInstanceIdSchema.safeParse(parsed.instanceId).success ? { instanceId: parsed.instanceId } : {}),
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

export function applySavedSelection(
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


const PER_PROVIDER_KEY = "matrix:canonical-chat-provider-preferences";
const SavedSelectionSchema = z.object({
  key: z.string().max(320), instanceId: CanonicalProviderInstanceIdSchema.optional(), interactionMode: z.string().max(80).optional(),
  permissionMode: z.string().max(80).optional(),
  options: z.array(z.object({ id: z.string().max(80), value: z.union([z.string().max(160), z.boolean()]) })).max(32).optional(),
});
export type SavedProviderPreferences = Record<string, SavedProviderSelection>;

export function readSavedProviderPreferences(): SavedProviderPreferences {
  const preferences: SavedProviderPreferences = {};
  if (typeof window === "undefined") return preferences;
  try {
    const stored = window.localStorage.getItem(PER_PROVIDER_KEY);
    if (stored && stored.length <= 200_000) {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, value] of Object.entries(parsed).slice(0, 20)) {
          const selection = SavedSelectionSchema.safeParse(value);
          if (CanonicalProviderInstanceIdSchema.safeParse(id).success && selection.success
            && selection.data.key.startsWith(`${id}:`)) preferences[id] = selection.data;
        }
      }
    }

  } catch (error: unknown) {
    console.warn("[chat] Provider preferences unavailable:", error instanceof Error ? error.name : "UnknownError");
  }
  return preferences;
}

export function rememberProviderPreference(preferences: SavedProviderPreferences, id: string, selection: SavedProviderSelection): SavedProviderPreferences {
  if (!CanonicalProviderInstanceIdSchema.safeParse(id).success) return preferences;
  const next = { ...preferences };
  delete next[id];
  next[id] = { ...selection, instanceId: id };
  for (const key of Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - 20))) delete next[key];
  try { window.localStorage.setItem(PER_PROVIDER_KEY, JSON.stringify(next)); }
  catch (error: unknown) {
    console.warn("[chat] Failed to save Provider preferences:", error instanceof Error ? error.name : "UnknownError");
  }
  return next;
}

export function saveLastProviderSelection(selection: SavedProviderSelection): void {
  try { window.localStorage.setItem(PROVIDER_SELECTION_STORAGE_KEY, JSON.stringify(selection)); }
  catch (error: unknown) {
    console.warn("[chat] Failed to save Provider selection:", error instanceof Error ? error.name : "UnknownError");
  }
}
