// Default coding-agent provider preference for new chats. Persistence rides
// the desktop local-state bridge under the "providerPreferences" key (listed
// in STATE_KEYS in desktop/src/shared/ipc-contract.ts and validated by
// ProviderPreferencesSchema in desktop/src/main/persistence/local-store.ts);
// if the bridge rejects the key the preference degrades to in-memory for the
// session with a console warning.
import "../../lib/operator";
import { create } from "zustand";
import { diagnosticErrorKind } from "../../lib/errors";
import {
  ComposerSelectionPreferenceSchema,
  type ComposerSelectionPreference,
  type ComposerSelectionPreferences,
} from "../../../../shared/provider-preferences";
import { CanonicalProviderInstanceIdSchema } from "@matrix-os/contracts";
import type { CanonicalComposerSelection } from "../chat/canonical-composer-state";

export const PROVIDER_PREFERENCES_STATE_KEY = "providerPreferences";

// Mirrors ProviderIdSchema in @matrix-os/contracts (kept local so the store
// never trusts persisted or caller-supplied values).
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_COMPOSER_SELECTIONS = 20;

interface ProviderPreferencesState {
  // null = automatic (composer picks the first ready provider).
  defaultProviderId: string | null;
  lastComposerInstanceId: string | null;
  composerSelections: ComposerSelectionPreferences;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDefaultProvider: (providerId: string | null) => void;
  setComposerSelection: (selection: CanonicalComposerSelection) => void;
}

function isValidProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function isValidInstanceId(value: unknown): value is string {
  return CanonicalProviderInstanceIdSchema.safeParse(value).success;
}

function logPersistence(context: string, err: unknown): void {
  console.warn(
    `[provider-preferences] ${context}:`,
    diagnosticErrorKind(err),
  );
}

function parseComposerPreference(value: unknown): ComposerSelectionPreference | null {
  const parsed = ComposerSelectionPreferenceSchema.safeParse(value);
  if (!parsed.success) return null;
  const optionIds = parsed.data.options.map((option) => option.id);
  return new Set(optionIds).size === optionIds.length ? parsed.data : null;
}

function parseComposerSelections(value: unknown): ComposerSelectionPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: ComposerSelectionPreferences = {};
  for (const [instanceId, preference] of Object.entries(value).slice(0, MAX_COMPOSER_SELECTIONS)) {
    if (!isValidInstanceId(instanceId)) continue;
    const valid = parseComposerPreference(preference);
    if (valid) parsed[instanceId] = valid;
  }
  return parsed;
}

function persistedPreferences(state: Pick<
  ProviderPreferencesState,
  "defaultProviderId" | "lastComposerInstanceId" | "composerSelections"
>): {
  defaultProviderId: string | null;
  lastComposerInstanceId?: string;
  composerSelections?: ComposerSelectionPreferences;
} {
  return {
    defaultProviderId: state.defaultProviderId,
    ...(state.lastComposerInstanceId ? { lastComposerInstanceId: state.lastComposerInstanceId } : {}),
    ...(Object.keys(state.composerSelections).length > 0
      ? { composerSelections: state.composerSelections }
      : {}),
  };
}

function persistCurrentPreferences(state: Pick<
  ProviderPreferencesState,
  "defaultProviderId" | "lastComposerInstanceId" | "composerSelections"
>): void {
  void window.operator
    .invoke("state:set", {
      key: PROVIDER_PREFERENCES_STATE_KEY,
      value: persistedPreferences(state),
    })
    .catch((err: unknown) => {
      logPersistence("could not persist Provider preferences", err);
    });
}

export const useProviderPreferences = create<ProviderPreferencesState>()((set, get) => ({
  defaultProviderId: null,
  lastComposerInstanceId: null,
  composerSelections: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const beforeHydration = get();
    let stored: unknown = null;
    try {
      const result = (await window.operator.invoke("state:get", {
        key: PROVIDER_PREFERENCES_STATE_KEY,
      })) as { value?: unknown };
      stored = result && typeof result === "object" ? result.value : null;
    } catch (err: unknown) {
      logPersistence("persisted default provider unavailable", err);
    }
    const candidate =
      stored && typeof stored === "object"
        ? (stored as { defaultProviderId?: unknown }).defaultProviderId
        : null;
    const composerSelections = stored && typeof stored === "object"
      ? parseComposerSelections((stored as { composerSelections?: unknown }).composerSelections)
      : {};
    const lastComposerInstanceId = stored && typeof stored === "object"
      && isValidInstanceId((stored as { lastComposerInstanceId?: unknown }).lastComposerInstanceId)
      ? (stored as { lastComposerInstanceId: string }).lastComposerInstanceId
      : null;
    const current = get();
    set({
      defaultProviderId: current.defaultProviderId !== beforeHydration.defaultProviderId
        ? current.defaultProviderId
        : isValidProviderId(candidate) ? candidate : null,
      composerSelections: current.composerSelections !== beforeHydration.composerSelections
        ? current.composerSelections
        : composerSelections,
      lastComposerInstanceId: current.lastComposerInstanceId !== beforeHydration.lastComposerInstanceId
        ? current.lastComposerInstanceId
        : lastComposerInstanceId,
      hydrated: true,
    });
  },

  setDefaultProvider: (providerId) => {
    if (providerId !== null && !isValidProviderId(providerId)) {
      console.warn("[provider-preferences] ignoring invalid provider id");
      return;
    }
    set({ defaultProviderId: providerId });
    persistCurrentPreferences({ ...get(), defaultProviderId: providerId });
  },

  setComposerSelection: (selection) => {
    if (!isValidInstanceId(selection.instanceId)) return;
    const preference = parseComposerPreference({
      model: selection.model,
      options: selection.options,
      permissionMode: selection.permissionMode,
    });
    if (!preference) return;
    const existing = get().composerSelections;
    const next = { ...existing, [selection.instanceId]: preference };
    const keys = Object.keys(next);
    if (keys.length > MAX_COMPOSER_SELECTIONS) {
      for (const key of keys.slice(0, keys.length - MAX_COMPOSER_SELECTIONS)) delete next[key];
    }
    set({ composerSelections: next, lastComposerInstanceId: selection.instanceId });
    persistCurrentPreferences({
      ...get(),
      composerSelections: next,
      lastComposerInstanceId: selection.instanceId,
    });
  },
}));
