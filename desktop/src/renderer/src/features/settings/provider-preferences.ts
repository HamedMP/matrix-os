// Default coding-agent provider preference for new chats. Persistence rides
// the desktop local-state bridge under the "providerPreferences" key (listed
// in STATE_KEYS in desktop/src/shared/ipc-contract.ts and validated by
// ProviderPreferencesSchema in desktop/src/main/persistence/local-store.ts);
// if the bridge rejects the key the preference degrades to in-memory for the
// session with a console warning.
import "../../lib/operator";
import { create } from "zustand";

export const PROVIDER_PREFERENCES_STATE_KEY = "providerPreferences";

// Mirrors ProviderIdSchema in @matrix-os/contracts (kept local so the store
// never trusts persisted or caller-supplied values).
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

interface ProviderPreferencesState {
  // null = automatic (composer picks the first ready provider).
  defaultProviderId: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDefaultProvider: (providerId: string | null) => void;
}

function isValidProviderId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_ID_PATTERN.test(value);
}

function logPersistence(context: string, err: unknown): void {
  console.warn(
    `[provider-preferences] ${context}:`,
    err instanceof Error ? err.message : String(err),
  );
}

export const useProviderPreferences = create<ProviderPreferencesState>()((set, get) => ({
  defaultProviderId: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
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
    set({ defaultProviderId: isValidProviderId(candidate) ? candidate : null, hydrated: true });
  },

  setDefaultProvider: (providerId) => {
    if (providerId !== null && !isValidProviderId(providerId)) {
      console.warn("[provider-preferences] ignoring invalid provider id");
      return;
    }
    set({ defaultProviderId: providerId });
    void window.operator
      .invoke("state:set", {
        key: PROVIDER_PREFERENCES_STATE_KEY,
        value: { defaultProviderId: providerId },
      })
      .catch((err: unknown) => {
        logPersistence("could not persist default provider", err);
      });
  },
}));
