// Default coding-agent provider preference for new chats. Persistence rides
// the desktop local-state bridge under the "providerPreferences" key (listed
// in STATE_KEYS in desktop/src/shared/ipc-contract.ts and validated by
// ProviderPreferencesSchema in desktop/src/main/persistence/local-store.ts);
// if the bridge rejects the key the preference degrades to in-memory for the
// session with a console warning.
import "../../lib/operator";
import { create } from "zustand";
import { diagnosticErrorKind } from "../../lib/errors";
import type { CanonicalComposerSelection } from "../chat/canonical-composer-state";

export const PROVIDER_PREFERENCES_STATE_KEY = "providerPreferences";

// Mirrors ProviderIdSchema in @matrix-os/contracts (kept local so the store
// never trusts persisted or caller-supplied values).
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_COMPOSER_SELECTIONS = 20;
const MAX_COMPOSER_OPTIONS = 16;
const MAX_OPTION_VALUE_LENGTH = 128;

export interface ComposerSelectionPreference {
  options: Array<{ id: string; value: string | boolean }>;
  permissionMode: string;
}

type ComposerSelectionPreferences = Record<string, ComposerSelectionPreference>;

interface ProviderPreferencesState {
  // null = automatic (composer picks the first ready provider).
  defaultProviderId: string | null;
  composerSelections: ComposerSelectionPreferences;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDefaultProvider: (providerId: string | null) => void;
  setComposerSelection: (selection: CanonicalComposerSelection) => void;
}

function isValidProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function logPersistence(context: string, err: unknown): void {
  console.warn(
    `[provider-preferences] ${context}:`,
    diagnosticErrorKind(err),
  );
}

function parseComposerPreference(value: unknown): ComposerSelectionPreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { options?: unknown; permissionMode?: unknown };
  if (!isValidProviderId(candidate.permissionMode) || !Array.isArray(candidate.options)
    || candidate.options.length > MAX_COMPOSER_OPTIONS) return null;
  const options: ComposerSelectionPreference["options"] = [];
  for (const option of candidate.options) {
    if (!option || typeof option !== "object") return null;
    const parsed = option as { id?: unknown; value?: unknown };
    if (!isValidProviderId(parsed.id)) return null;
    if (typeof parsed.value !== "boolean"
      && (typeof parsed.value !== "string" || parsed.value.length > MAX_OPTION_VALUE_LENGTH)) return null;
    if (options.some((existing) => existing.id === parsed.id)) return null;
    options.push({ id: parsed.id, value: parsed.value });
  }
  return { options, permissionMode: candidate.permissionMode };
}

function parseComposerSelections(value: unknown): ComposerSelectionPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const parsed: ComposerSelectionPreferences = {};
  for (const [instanceId, preference] of Object.entries(value).slice(0, MAX_COMPOSER_SELECTIONS)) {
    if (!isValidProviderId(instanceId)) continue;
    const valid = parseComposerPreference(preference);
    if (valid) parsed[instanceId] = valid;
  }
  return parsed;
}

function persistedPreferences(state: Pick<
  ProviderPreferencesState,
  "defaultProviderId" | "composerSelections"
>): { defaultProviderId: string | null; composerSelections?: ComposerSelectionPreferences } {
  return Object.keys(state.composerSelections).length > 0
    ? { defaultProviderId: state.defaultProviderId, composerSelections: state.composerSelections }
    : { defaultProviderId: state.defaultProviderId };
}

function persistCurrentPreferences(state: Pick<
  ProviderPreferencesState,
  "defaultProviderId" | "composerSelections"
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
    const current = get();
    set({
      defaultProviderId: current.defaultProviderId !== beforeHydration.defaultProviderId
        ? current.defaultProviderId
        : isValidProviderId(candidate) ? candidate : null,
      composerSelections: current.composerSelections !== beforeHydration.composerSelections
        ? current.composerSelections
        : composerSelections,
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
    if (!isValidProviderId(selection.instanceId)) return;
    const preference = parseComposerPreference({
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
    set({ composerSelections: next });
    persistCurrentPreferences({ ...get(), composerSelections: next });
  },
}));
