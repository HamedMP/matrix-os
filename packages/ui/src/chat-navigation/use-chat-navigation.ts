import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import type { CanonicalChatEventSource } from "../canonical-chat-event-source.js";
import { createChatNavigationStore, EMPTY_CHAT_NAVIGATION, type ChatNavigationPersistence, type ChatNavigationStore } from "./store.js";
type Source = Pick<CanonicalChatEventSource, "subscribe">;
type Entry = {
  store: ChatNavigationStore;
  generation: string;
  users: number;
  sources: Map<Source, number>;
  subscription?: {
    dispose(): void;
  };
  source?: Source;
  lastCursor: number;
};
function connect(entry: Entry) {
  const source = entry.sources.keys().next().value as Source | undefined;
  if (source === entry.source) {
    return;
  }
  entry.subscription?.dispose();
  entry.source = source;
  entry.subscription = source?.subscribe(event => {
    if (event.type === "chat.changed" && event.eventType === "run.message") {
      return;
    }
    if (event.cursor !== undefined) {
      if (event.cursor <= entry.lastCursor) {
        return;
      }
      entry.lastCursor = event.cursor;
    }
    // A full refresh represents replayed changes or a gap, not an empty
    // attachment. An in-flight snapshot may predate recovery: keep its dirty
    // follow-up rather than dropping the only durable correction signal.
    void entry.store.refresh();
  });
}
const stores = new Map<string, Entry>(); // max three scopes; unmounted least-recent entry evicted
export function clearChatNavigationScopes(prefix?: string) {
  for (const [key, entry] of stores) {
    if (!prefix || key.startsWith(prefix)) {
      entry.subscription?.dispose();
      entry.store.dispose(true);
      stores.delete(key);
    }
  }
}
function scopedStore(scope: string, generation: string, load: () => Promise<CanonicalChatNavigationResponse>, persistence?: ChatNavigationPersistence) {
  let entry = stores.get(scope);
  if (entry && entry.generation !== generation) {
    entry = undefined;
  }
  if (!entry) {
    entry = { store: createChatNavigationStore({ load, persistence }), generation, users: 0, sources: new Map(), lastCursor: -1 };
    if (!stores.has(scope) && stores.size < 3) {
      stores.set(scope, entry);
    }
  }
  return entry;
}
export function useChatNavigation({ scope, generation = "0", load, persistence, eventSource, active = true }: {
  scope: string | null;
  generation?: string;
  load: () => Promise<CanonicalChatNavigationResponse>;
  persistence?: ChatNavigationPersistence;
  eventSource?: Pick<CanonicalChatEventSource, "subscribe"> | null;
  active?: boolean;
}) {
  const entry = useMemo(() => scope ? scopedStore(scope, generation, load, persistence) : null, [scope, generation]);
  useEffect(() => {
    if (!entry || !scope) {
      return;
    }
    const previous = stores.get(scope);
    if (previous && previous !== entry) {
      previous.subscription?.dispose();
      previous.store.dispose();
      stores.delete(scope);
    }
    if (!stores.has(scope)) {
      if (stores.size >= 3) {
        const candidate = [...stores].find(([, value]) => value.users === 0);
        if (candidate) {
          candidate[1].store.dispose();
          stores.delete(candidate[0]);
        }
      }
      if (stores.size < 3) {
        stores.set(scope, entry);
      }
    }
    entry.store.configure({ load, persistence });
  }, [entry, scope, load, persistence]);
  const state = useSyncExternalStore(entry?.store.subscribe ?? (() => () => {
  }), entry?.store.getSnapshot ?? (() => EMPTY_CHAT_NAVIGATION), () => EMPTY_CHAT_NAVIGATION);
  useEffect(() => {
    if (!entry || !active) {
      return;
    }
    // Touch only after commit: speculative renders must not change eviction
    // order or replace the authority that mounted consumers still use.
    if (scope && stores.get(scope) === entry) {
      stores.delete(scope);
      stores.set(scope, entry);
    }
    entry.users++;
    void entry.store.ensure();
    const registeredSource = eventSource && (entry.sources.has(eventSource) || entry.sources.size < 16);
    if (registeredSource && eventSource) {
      entry.sources.set(eventSource, (entry.sources.get(eventSource) ?? 0) + 1);
      connect(entry);
    }
    const focus = () => {
      void entry.store.ensure();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void entry.store.ensure();
      }
    }, 60000);
    window.addEventListener("focus", focus);
    return () => {
      entry.users--;
      if (registeredSource && eventSource) {
        const count = (entry.sources.get(eventSource) ?? 1) - 1;
        if (count) {
          entry.sources.set(eventSource, count);
        }
        else {
          entry.sources.delete(eventSource);
        }
        connect(entry);
      }
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [entry, scope, active, eventSource]);
  return { ...state, store: entry?.store ?? null };
}
