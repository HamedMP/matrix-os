import AsyncStorage from "@react-native-async-storage/async-storage";
import { CanonicalChatModelSelectionSchema, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { z } from "zod/v4";

/**
 * What the composer was last set to on this phone, for one account's computer:
 * a new chat starts from it when nothing better is known. Every part is
 * optional and remembered on its own, so a control added beside the model
 * picker adds a field here without touching the rest.
 */
export interface RememberedComposerChoice {
  selection?: CanonicalChatModelSelection;
  /**
   * The permission mode last chosen for this selection's provider instance.
   * A first-use instance receives its catalog default, never another's mode.
   */
  permissionMode?: string;
}

interface ComposerChoiceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface Entry {
  scope: string;
  choice: RememberedComposerChoice;
  providers?: RememberedComposerChoice[];
}

const STORAGE_KEY = "matrix_os_composer_choice_v1";
export const MAX_REMEMBERED_COMPUTERS = 8;
export const MAX_REMEMBERED_PROVIDERS = 20;

const ScopeSchema = z.string().min(1).max(400);
const ChoiceSchema = z.object({
  selection: CanonicalChatModelSelectionSchema.optional(),
  // A mode that cannot be read is dropped on its own, keeping the model saved with it.
  permissionMode: z.string().min(1).max(80).optional().catch(undefined),
});
const EntrySchema = z.object({ scope: ScopeSchema, choice: ChoiceSchema,
  providers: z.array(z.unknown()).max(MAX_REMEMBERED_PROVIDERS * 4).optional().catch(undefined),
});

/** Last occurrence wins; the legacy single choice seeds its own instance only. */
function providerChoices(...sources: readonly RememberedComposerChoice[][]): RememberedComposerChoice[] {
  const choices: RememberedComposerChoice[] = [];
  for (const source of sources) for (const choice of source) {
    if (!choice.selection) continue;
    const previous = choices.findIndex(value => value.selection?.instanceId === choice.selection?.instanceId);
    if (previous !== -1) choices.splice(previous, 1);
    choices.push(choice);
  }
  return choices.slice(-MAX_REMEMBERED_PROVIDERS);
}

function entryProviders(entry: Entry | undefined): RememberedComposerChoice[] {
  return entry ? providerChoices(entry.providers ?? [], [entry.choice]) : [];
}
const StoredSchema = z.object({ entries: z.array(z.unknown()).max(MAX_REMEMBERED_COMPUTERS * 4) });

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** The saved entries that can still be read as choices; one that cannot is left out, not the rest. */
function parseEntries(raw: string | null): Entry[] {
  if (raw === null || raw.length > 2_000_000) return [];
  const stored = StoredSchema.safeParse(JSON.parse(raw));
  if (!stored.success) return [];
  return stored.data.entries
    .flatMap((value) => {
      const entry = EntrySchema.safeParse(value);
      if (!entry.success) return [];
      const providers = (entry.data.providers ?? []).flatMap(value => {
        const choice = ChoiceSchema.safeParse(value);
        return choice.success && choice.data.selection ? [choice.data] : [];
      });
      return [{ ...entry.data, providers: providerChoices(providers, [entry.data.choice]) }];
    })
    .slice(-MAX_REMEMBERED_COMPUTERS);
}

/**
 * The choices remembered on this phone, read from its storage once and kept in
 * memory. The most recently changed computer's is the last to be dropped.
 */
export function createComposerChoiceStore(storage: ComposerChoiceStorage = AsyncStorage) {
  let entries: readonly Entry[] | null = null;
  let reading: Promise<void> | null = null;
  // Writes go out one after another, so an older one never lands last.
  let writing: Promise<void> = Promise.resolve();
  // One per mounted composer that reads the choice.
  let listeners: readonly (() => void)[] = [];

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const load = (): Promise<void> => {
    reading ??= storage.getItem(STORAGE_KEY)
      .then(parseEntries)
      .catch((error: unknown) => {
        console.warn("[mobile] remembered composer choice unavailable", failureName(error));
        return [];
      })
      .then((read) => {
        // A choice made while the storage was being read is newer than what it held.
        const made = entries ?? [];
        entries = [...read.filter(saved => !made.some(value => value.scope === saved.scope)),
          ...made.map(value => ({ ...value, providers: providerChoices(
            entryProviders(read.find(saved => saved.scope === value.scope)), entryProviders(value),
          ) })),
        ].slice(-MAX_REMEMBERED_COMPUTERS);
        notify();
      });
    return reading;
  };

  const save = () => {
    const snapshot = JSON.stringify({ entries: entries ?? [] });
    writing = writing
      .then(() => storage.setItem(STORAGE_KEY, snapshot))
      .catch((error: unknown) => {
        console.warn("[mobile] composer choice could not be remembered", failureName(error));
      });
  };

  return {
    load,
    /** The choice remembered for `scope`: undefined until the storage has been read, null when there is none. */
    choice(scope: string, instanceId?: string): RememberedComposerChoice | null | undefined {
      if (entries === null) return undefined;
      const entry = entries.find(value => value.scope === scope);
      return instanceId === undefined ? entry?.choice ?? null
        : entryProviders(entry).find(value => value.selection?.instanceId === instanceId) ?? null;
    },
    /** Remembers the parts of a choice given, keeping the parts not given. */
    remember(scope: string, patch: RememberedComposerChoice) {
      if (!ScopeSchema.safeParse(scope).success) return;
      const current = entries ?? [];
      const entry = current.find(value => value.scope === scope);
      const previous = entry?.choice;
      const targetId = patch.selection?.instanceId ?? previous?.selection?.instanceId;
      const target = entryProviders(entry).find(value => value.selection?.instanceId === targetId);
      const choice = { ...previous, permissionMode: target?.permissionMode, ...target, ...patch };
      entries = [
        ...current.filter((entry) => entry.scope !== scope),
        { scope, choice, providers: providerChoices(entryProviders(entry), [choice]) },
      ].slice(-MAX_REMEMBERED_COMPUTERS);
      notify();
      // What the storage holds for other computers is kept: it is read first.
      void load().then(save);
    },
    /**
     * Forgets every remembered choice, in memory and on the phone. The store
     * is then unread, as on a fresh launch: the next reader reads the storage
     * again.
     */
    async forget() {
      entries = [];
      reading = Promise.resolve();
      save();
      await writing;
      entries = null;
      reading = null;
      notify();
    },
    subscribe(listener: () => void) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((existing) => existing !== listener);
      };
    },
    /** Changes whenever a choice does, for React to compare. */
    snapshot: () => entries,
  };
}

export const composerChoices = createComposerChoiceStore();

/** The key a computer's choice is remembered under: the account and the computer, as the chat drafts are. */
export function composerChoiceScope(
  userId: string | null | undefined,
  computer: { handle: string; runtimeSlot: string } | null | undefined,
): string | null {
  return userId && computer ? `${userId}:${computer.handle}:${computer.runtimeSlot}` : null;
}

/**
 * The composer choice remembered on this phone for `scope`, and a way to
 * remember a new one. `ready` is false while the phone's storage is read.
 */
export function useRememberedComposerChoice(scope: string | null) {
  useEffect(() => {
    void composerChoices.load();
  }, []);
  useSyncExternalStore(composerChoices.subscribe, composerChoices.snapshot);
  const choice = scope === null ? null : composerChoices.choice(scope);
  const remember = useCallback((patch: RememberedComposerChoice) => {
    if (scope !== null) composerChoices.remember(scope, patch);
  }, [scope]);
  return { choice: choice ?? null, ready: choice !== undefined, remember,
    forProvider: (instanceId: string | undefined) => scope !== null && instanceId
      ? composerChoices.choice(scope, instanceId) ?? null : null,
  };
}
