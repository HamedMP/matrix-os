import { markChatNavigation } from "./metrics.js";
import { mergeChatNavigationRecord, type ChatNavigationRecord } from "./projection.js";
import { CanonicalChatNavigationItemSchema, CanonicalChatNavigationResponseSchema, type CanonicalChatNavigationItem, type CanonicalChatNavigationResponse } from "@matrix-os/contracts";
export interface ChatNavigationPersistence {
  load(): Promise<CanonicalChatNavigationResponse | null>;
  save(snapshot: CanonicalChatNavigationResponse): Promise<void>;
  clear(): Promise<void>;
}
export interface ChatNavigationState {
  items: CanonicalChatNavigationItem[];
  status: "idle" | "loading" | "ready" | "error";
  fresh: boolean;
  truncated: boolean;
  updatedAt: number;
  error: string | null;
}
export const EMPTY_CHAT_NAVIGATION: ChatNavigationState = { items: [], status: "idle", fresh: false, truncated: false, updatedAt: 0, error: null };
export const CHAT_NAVIGATION_STALE_MS = 60000;
export class ChatNavigationAuthorityRevoked extends Error {
  constructor() {
    super("Chat navigation authority revoked");
    this.name = "ChatNavigationAuthorityRevoked";
  }
}
// Streaming does not order pin/mute, completion acknowledgements, run state,
// Project/provider binding or lifecycle. Those always come from the base record.
function mergeStreamPatch(current: CanonicalChatNavigationItem, incoming: ChatNavigationRecord) {
  const title = (incoming.chat.titleVersion ?? 0) > (current.chat.titleVersion ?? 0) ? incoming.chat : current.chat;
  const read = incoming.readState && incoming.readState.version > current.readState.version ? incoming.readState : current.readState;
  const later = (a: string | undefined, b: string | undefined) => !a || (b && Date.parse(b) > Date.parse(a)) ? b : a;
  return mergeChatNavigationRecord(current, { ...current, chat: { ...current.chat,
    revision: Math.max(current.chat.revision, incoming.chat.revision),
    title: title.title, titleVersion: title.titleVersion,
    messageCount: Math.max(current.chat.messageCount, incoming.chat.messageCount),
    activityAt: later(current.chat.activityAt, incoming.chat.activityAt),
    updatedAt: later(current.chat.updatedAt, incoming.chat.updatedAt) ?? current.chat.updatedAt,
  }, readState: { ...read, latestIncomingSeq: Math.max(current.readState.latestIncomingSeq, incoming.readState?.latestIncomingSeq ?? 0) } });
}
/** Disposable, authenticated-scope UI state. A mutation invalidates older reads. */
export function createChatNavigationStore(options: {
  load(): Promise<CanonicalChatNavigationResponse>;
  persistence?: ChatNavigationPersistence;
  now?: () => number;
}) {
  let state: ChatNavigationState = EMPTY_CHAT_NAVIGATION;
  let loader = options.load;
  let persistence = options.persistence;
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<() => void>(); // capped subscriptions, explicitly removed
  let generation = 0;
  let revision = 0;
  let patchVersion = 0;
  // At most the current 1,000 known rows; authoritative removal evicts overlays.
  const patches = new Map<string, CanonicalChatNavigationItem>();
  const prunePatches = (items: CanonicalChatNavigationItem[]) => {
    const ids = new Set(items.map(item => item.chat.id));
    for (const id of patches.keys()) if (!ids.has(id)) patches.delete(id);
  };
  let disposed = false;
  let revoked = false;
  let cacheClear: Promise<void> = Promise.resolve();
  let hydrated = false;
  let hydratePromise: Promise<void> | undefined;
  let inFlight: Promise<void> | undefined;
  let dirty = false;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: ChatNavigationState) => {
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      }
      catch (error: unknown) {
        console.warn("[chat-navigation] Subscriber failed:", error instanceof Error ? error.name : "UnknownError");
      }
    }
  };
  const warn = (kind: string, error: unknown) => console.warn(`[chat-navigation] ${kind}:`, error instanceof Error ? error.name : "UnknownError");
  const clearCache = () => {
    const adapter = persistence;
    cacheClear = cacheClear.then(() => adapter?.clear()).catch(error => warn("Cache clear failed", error));
  };
  const revoke = () => {
    if (disposed) return;
    generation++;
    revoked = true;
    patches.clear();
    dirty = false;
    // A new authenticated read may proceed without waiting for superseded I/O.
    inFlight = undefined;
    hydrated = true;
    if (writeTimer !== undefined) clearTimeout(writeTimer);
    writeTimer = undefined;
    clearCache();
    publish({ ...EMPTY_CHAT_NAVIGATION, status: "error", error: "Your session has expired. Please sign in again." });
  };
  const persist = (value: CanonicalChatNavigationResponse, fence: number, version: number) => {
    const liveVersion = patchVersion;
    if (!persistence || value.truncated || patches.size) {
      return;
    }
    if (writeTimer !== undefined) {
      clearTimeout(writeTimer);
    }
    writeTimer = setTimeout(() => {
      writeTimer = undefined;
      if (disposed || generation !== fence || revision !== version || patchVersion !== liveVersion) {
        return;
      }
      // Membership-sensitive rows are never reconstructed from a local file.
      const personal = { ...value, items: value.items.filter(item => item.persistence === "personal") };
      void cacheClear.then(async () => {
        if (disposed || generation !== fence || revision !== version || patchVersion !== liveVersion) return;
        await persistence?.save(personal);
      }).catch(error => warn("Cache save failed", error));
    }, 0);
  };
  const hydrate = () => {
    if (hydrated) {
      return Promise.resolve();
    }
    if (hydratePromise) {
      return hydratePromise;
    }
    hydrated = true;
    const fence = generation;
    hydratePromise = (async () => {
      try {
        const cached = await persistence?.load();
        if (!cached || disposed || fence !== generation || state.updatedAt !== 0 || revision !== 0) {
          return;
        }
        const value = CanonicalChatNavigationResponseSchema.parse(cached);
        if (value.truncated || value.items.some(item => item.persistence !== "personal")) {
          return;
        }
        markChatNavigation("cache-ready", value.items.length);
        publish({ ...state, items: value.items, status: state.status === "error" ? "error" : "ready", fresh: false, truncated: false });
      }
      catch (error: unknown) {
        warn("Cache unavailable", error);
      }
    })();
    return hydratePromise;
  };
  const refresh = (): Promise<void> => {
    if (disposed) {
      return Promise.resolve();
    }
    if (inFlight) {
      dirty = true;
      return inFlight;
    }
    const fence = generation;
    publish({ ...state, status: state.items.length ? state.status : "loading", error: null });
    const request = (async () => {
      do {
        dirty = false;
        const version = revision;
        try {
          const value = CanonicalChatNavigationResponseSchema.parse(await loader());
          if (disposed || fence !== generation) {
            return;
          }
          if (revision !== version) {
            dirty = true;
            continue;
          }
          revoked = false;
          markChatNavigation("snapshot-ready", value.items.length);
          const items = value.items.map(item => {
            const patch = patches.get(item.chat.id);
            if (!patch) return item;
            const merged = CanonicalChatNavigationItemSchema.parse(mergeStreamPatch(item, patch));
            // Persist only when the server has independently caught up. Live
            // overlays cannot add membership or replace classification policy.
            if (JSON.stringify(merged) === JSON.stringify(item)) patches.delete(item.chat.id);
            else patches.set(item.chat.id, merged);
            return merged;
          });
          prunePatches(items);
          publish({ items, status: "ready", fresh: true, truncated: value.truncated, updatedAt: now(), error: null });
          persist(value, fence, version);
        }
        catch (error: unknown) {
          if (disposed || fence !== generation) {
            return;
          }
          warn("List unavailable", error);
          if (error instanceof ChatNavigationAuthorityRevoked) {
            revoke();
            return;
          }
          publish({ ...state, status: "error", fresh: false, error: "Chats could not be loaded. Try again." });
          // A failed fetch needs an explicit retry/focus, not a tight error loop.
          dirty = false;
        }
      } while (dirty && !disposed && fence === generation);
    })().finally(() => {
      if (inFlight === request) inFlight = undefined;
    });
    inFlight = request;
    return request;
  };
  return {
    getSnapshot: () => state,
    getAuthorityEpoch: () => generation,
    patch(record: ChatNavigationRecord) {
      if (disposed || revoked) return;
      const current = state.items.find(item => item.chat.id === record.chat.id);
      if (!current) return;
      const merged = mergeStreamPatch(current, record);
      patches.set(record.chat.id, merged);
      patchVersion++;
      publish({ ...state, items: state.items.map(item => item === current ? merged : item) });
      // Metadata events neither invalidate nor restart an in-flight list read.
    },
    subscribe(listener: () => void) {
      if (listeners.size >= 64) {
        throw new Error("NavigationSubscriberLimit");
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ensure() {
      if (disposed) {
        return Promise.resolve();
      }
      void hydrate();
      if (inFlight) {
        return inFlight;
      }
      return state.fresh && now() - state.updatedAt < CHAT_NAVIGATION_STALE_MS ? Promise.resolve() : refresh();
    },
    refresh,
    revoke,
    update(update: (items: CanonicalChatNavigationItem[]) => CanonicalChatNavigationItem[]) {
      if (disposed || revoked) {
        return;
      }
      const updated = update(state.items);
      if (updated === state.items) {
        return;
      }
      const previous = new Map(state.items.map(item => [item.chat.id, item]));
      const items = (updated.length > 1000 ? updated.slice(0, 1000) : updated).map(item => {
        const patch = patches.get(item.chat.id);
        if (!patch || previous.get(item.chat.id) === item) return item;
        // The mutation supersedes the old overlay. Retain only stream clocks
        // that are still ahead of that response, never its old user/run fields.
        patches.delete(item.chat.id);
        const merged = CanonicalChatNavigationItemSchema.parse(mergeStreamPatch(item, patch));
        if (JSON.stringify(merged) !== JSON.stringify(CanonicalChatNavigationItemSchema.parse(item))) patches.set(item.chat.id, merged);
        return merged;
      });
      revision++;
      prunePatches(items);
      if (inFlight) {
        dirty = true;
      }
      publish({ ...state, items });
      // Never write optimistic or partially reconciled state to disk.
    },
    configure(next: {
      load: () => Promise<CanonicalChatNavigationResponse>;
      persistence?: ChatNavigationPersistence;
    }) {
      loader = next.load;
      persistence = next.persistence;
    },
    dispose(clear = false) {
      disposed = true;
      patches.clear();
      generation++;
      dirty = false;
      if (writeTimer !== undefined) {
        clearTimeout(writeTimer);
      }
      publish(EMPTY_CHAT_NAVIGATION);
      listeners.clear();
      if (clear) {
        clearCache();
      }
    },
  };
}
export type ChatNavigationStore = ReturnType<typeof createChatNavigationStore>;
