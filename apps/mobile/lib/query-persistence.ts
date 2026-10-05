import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Keeps a few launch-critical queries on disk so the next cold start can paint
 * the shell from the last known state instead of waiting on the network.
 *
 * Restored data is display state only: it is loaded with its original
 * timestamp, so every query that reads it still refetches straight away, and
 * the server stays the authority on anything the data is used for.
 */

export interface PersistedQueryKind<T = unknown> {
  /** Storage slot. One query is kept per kind: the most recently updated one. */
  id: string;
  /** The user a query of this kind belongs to, or null when `queryKey` is another kind. */
  ownerOf(queryKey: QueryKey): string | null;
  /** Validates data read back from disk. Throws when it no longer fits the app's schema. */
  parse(data: unknown): T;
}

export interface QueryPersistenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface QueryPersistence {
  /** Loads saved queries into the cache. Safe to call more than once; never rejects. */
  restore(): Promise<void>;
  /** Starts saving query results as they arrive. Returns a function that stops it. */
  start(): () => void;
  /** The signed-in user, or null when signed out. Drops everything saved for anyone else. */
  setOwner(userId: string | null): Promise<void>;
}

const STORAGE_PREFIX = "matrix_os_query_cache_v1:";
// Older than this, a launch from the saved state would mislead more than help.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A chat list or model catalog is tens of kilobytes; anything far larger is not worth a launch-time parse.
const MAX_ENTRY_CHARS = 512 * 1024;
// Streaming refreshes the chat list every couple of seconds; one write per burst is enough.
const SAVE_DEBOUNCE_MS = 1_000;

interface SavedQuery {
  userId: string;
  queryKey: unknown[];
  updatedAt: number;
  data: unknown;
}

function isSavedQuery(value: unknown): value is SavedQuery {
  if (typeof value !== "object" || value === null) return false;
  const saved = value as Partial<SavedQuery>;
  return typeof saved.userId === "string"
    && Array.isArray(saved.queryKey)
    && typeof saved.updatedAt === "number"
    && "data" in saved;
}

function failureName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

export function createQueryPersistence(options: {
  queryClient: QueryClient;
  storage: QueryPersistenceStorage;
  kinds: readonly PersistedQueryKind[];
  now?: () => number;
}): QueryPersistence {
  const { queryClient, storage, kinds } = options;
  const now = options.now ?? Date.now;
  // undefined until sign-in state is known; nothing is saved before then.
  let owner: string | null | undefined;
  let restoring: Promise<void> | undefined;
  // Both maps are keyed by kind id, so they never hold more than `kinds.length` entries.
  // What is known to be on disk: restored at launch, or saved since.
  const stored = new Map<string, Omit<SavedQuery, "data">>();
  const unsaved = new Map<string, { kind: PersistedQueryKind; query: Query }>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const storageKey = (kind: PersistedQueryKind) => `${STORAGE_PREFIX}${kind.id}`;

  // Writes to one slot run one after another, also keyed by kind id. A slow
  // write then cannot land on top of a later one, or be undone by a removal
  // that was meant for what the slot held before.
  const slotQueues = new Map<string, Promise<void>>();
  function inSlotOrder(kind: PersistedQueryKind, write: () => Promise<void>): Promise<void> {
    const turn = (slotQueues.get(kind.id) ?? Promise.resolve()).then(write);
    slotQueues.set(kind.id, turn);
    return turn;
  }

  async function removeSlot(kind: PersistedQueryKind) {
    stored.delete(kind.id);
    try {
      await storage.removeItem(storageKey(kind));
    } catch (error: unknown) {
      console.warn("[query-persistence] could not remove a saved query", failureName(error));
    }
  }

  const forget = (kind: PersistedQueryKind) => inSlotOrder(kind, () => removeSlot(kind));

  async function restoreKind(kind: PersistedQueryKind) {
    let raw: string | null;
    try {
      raw = await storage.getItem(storageKey(kind));
    } catch (error: unknown) {
      console.warn("[query-persistence] could not read a saved query", failureName(error));
      return;
    }
    if (raw === null) return;

    let saved: SavedQuery;
    let data: unknown;
    try {
      const value: unknown = JSON.parse(raw);
      if (!isSavedQuery(value)) throw new Error("Unrecognized saved query");
      if (now() - value.updatedAt > MAX_AGE_MS) throw new Error("Saved query expired");
      if (kind.ownerOf(value.queryKey) !== value.userId) throw new Error("Saved query key mismatch");
      data = kind.parse(value.data);
      saved = value;
    } catch (error: unknown) {
      // Written by an older build, expired, or damaged: the next fetch replaces it.
      console.warn("[query-persistence] dropped a saved query", failureName(error));
      await forget(kind);
      return;
    }

    if (owner !== undefined && owner !== saved.userId) {
      await forget(kind);
      return;
    }
    stored.set(kind.id, saved);
    // A fetch that already finished is newer than anything on disk.
    const current = queryClient.getQueryState(saved.queryKey);
    if (current && current.dataUpdatedAt >= saved.updatedAt) return;
    queryClient.setQueryData(saved.queryKey, data, { updatedAt: saved.updatedAt });
  }

  // Runs in the slot's turn, so who is signed in is judged when the write
  // starts: a save queued for a user who has since left is skipped.
  async function writeSlot(kind: PersistedQueryKind, query: Query) {
    const userId = kind.ownerOf(query.queryKey);
    const { data, dataUpdatedAt } = query.state;
    if (userId === null || userId !== owner || data === undefined || data === null) return;
    const saved: SavedQuery = { userId, queryKey: [...query.queryKey], updatedAt: dataUpdatedAt, data };
    let serialized: string;
    try {
      serialized = JSON.stringify(saved);
    } catch (error: unknown) {
      console.warn("[query-persistence] could not serialize a query", failureName(error));
      return;
    }
    if (serialized.length > MAX_ENTRY_CHARS) {
      // Leaving the previous value in place would restore something the user has moved past.
      await removeSlot(kind);
      return;
    }
    try {
      await storage.setItem(storageKey(kind), serialized);
    } catch (error: unknown) {
      console.warn("[query-persistence] could not save a query", failureName(error));
      return;
    }
    stored.set(kind.id, { userId, queryKey: saved.queryKey, updatedAt: dataUpdatedAt });
  }

  const save = (kind: PersistedQueryKind, query: Query) => inSlotOrder(kind, () => writeSlot(kind, query));

  function flush() {
    saveTimer = undefined;
    const waiting = [...unsaved.values()];
    unsaved.clear();
    for (const { kind, query } of waiting) void save(kind, query);
  }

  return {
    restore() {
      restoring ??= Promise.all(kinds.map(restoreKind)).then(() => undefined);
      return restoring;
    },

    start() {
      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "success") return;
        const query = event.query;
        const kind = kinds.find((candidate) => candidate.ownerOf(query.queryKey) !== null);
        if (!kind) return;
        // Restoring writes into the cache too; that data is already on disk.
        if (stored.get(kind.id)?.updatedAt === query.state.dataUpdatedAt) return;
        unsaved.set(kind.id, { kind, query });
        saveTimer ??= setTimeout(flush, SAVE_DEBOUNCE_MS);
      });
      return () => {
        unsubscribe();
        clearTimeout(saveTimer);
        saveTimer = undefined;
        unsaved.clear();
      };
    },

    async setOwner(userId) {
      owner = userId;
      // Restoring first means every entry on disk is accounted for below, and
      // one still being read cannot bring back another user's data after this.
      await this.restore();
      // The owner can change again during either wait below. The later call
      // then does the clean-up for whoever is signed in; this one, acting on
      // who it was called for, would remove that user's data.
      if (owner !== userId) return;
      for (const [kindId, query] of [...unsaved]) {
        if (query.kind.ownerOf(query.query.queryKey) !== userId) unsaved.delete(kindId);
      }
      // Each slot is looked at in its own turn, behind any write that was
      // already under way for the previous user.
      await Promise.all(kinds.map((kind) => inSlotOrder(kind, async () => {
        if (owner !== userId) return;
        const entry = stored.get(kind.id);
        if (entry && entry.userId !== userId) queryClient.removeQueries({ queryKey: entry.queryKey, exact: true });
        if (userId === null || (entry !== undefined && entry.userId !== userId)) await removeSlot(kind);
      })));
    },
  };
}
