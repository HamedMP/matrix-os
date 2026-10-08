"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { ChatNavigationAuthorityRevoked, clearChatNavigationScopes, createBrowserChatNavigationPersistence, legacyChatNavigation, useChatNavigation, type CanonicalChatEventSource, type ChatAgentClient, type ChatNavigationStore } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { CanonicalShellChatRequestError } from "@/lib/canonical-chat-client";
// Weak store keys retain at most one identity per live store, never a revoked
// epoch's Bot classification. Surface remounts in the same store share reads.
const legacyClients = new WeakMap<ChatNavigationStore, { source: ChatAgentClient; epoch: number; client: ChatAgentClient }>();
function legacyReadClient(store: ChatNavigationStore, source: ChatAgentClient | undefined) {
  if (!source) return undefined;
  const epoch = store.getAuthorityEpoch();
  const current = legacyClients.get(store);
  if (current?.source === source && current.epoch === epoch) return current.client;
  const client = { ...source };
  legacyClients.set(store, { source, epoch, client });
  return client;
}
let transientSequence = 0;
const transientScopes = new WeakMap<CanonicalShellChatClient, string>();
function transientScope(client: CanonicalShellChatClient): string {
  const known = transientScopes.get(client);
  if (known) return known;
  const scope = `web-memory:${++transientSequence}`;
  transientScopes.set(client, scope);
  return scope;
}
/** The host supplies a verified viewer/runtime key; standalone hooks stay memory-only. */
export function useShellChatNavigation(client: CanonicalShellChatClient, eventSource: CanonicalChatEventSource, scope?: string, generation = "0") {
  const transient = useMemo(() => transientScope(client), [client]);
  const previous = useRef<string | undefined>(scope);
  useEffect(() => {
    if (previous.current && previous.current.split("/runtime/")[0] !== scope?.split("/runtime/")[0]) {
      const owner = previous.current.split("/runtime/")[0]!;
      clearChatNavigationScopes(owner);
      try {
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const key = localStorage.key(index);
          if (key?.startsWith(`matrix-chat-navigation:v1:${owner}/runtime/`)) {
            localStorage.removeItem(key);
          }
        }
      }
      catch (error: unknown) {
        console.warn("[chat-navigation] Logout cache unavailable:", error instanceof Error ? error.name : "UnknownError");
      }
    }
    previous.current = scope;
  }, [scope]);
  const persistence = useMemo(() => {
    if (!scope) {
      return undefined;
    }
    try {
      return createBrowserChatNavigationPersistence(localStorage, scope);
    }
    catch (error: unknown) {
      console.warn("[chat-navigation] Storage unavailable:", error instanceof Error ? error.name : "UnknownError");
      return undefined;
    }
  }, [scope]);
  const loadAuthority = useRef<{ client: CanonicalShellChatClient; scope: string | undefined; generation: string; store: ChatNavigationStore | null } | null>(null);
  const load = useCallback(async () => {
    const authority = loadAuthority.current;
    if (!authority?.store || authority.client !== client || authority.scope !== scope || authority.generation !== generation) {
      throw new Error("NavigationAuthorityUnavailable");
    }
    const store = authority.store;
    const epoch = store.getAuthorityEpoch();
    const agents = legacyReadClient(store, client.agents);
    const assertCurrent = () => {
      if (store.getAuthorityEpoch() !== epoch) throw new Error("NavigationAuthorityChanged");
    };
    if (client.navigation) {
      try {
        return await client.navigation();
      }
      catch (error: unknown) {
        if (error instanceof CanonicalShellChatRequestError && (error.status === 401 || error.status === 403)) {
          throw new ChatNavigationAuthorityRevoked();
        }
        if (!(error instanceof CanonicalShellChatRequestError && error.status === 404)) {
          throw error;
        }
      }
    }
    try {
      assertCurrent();
      const records: CanonicalChatRecord[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < 10; index++) {
        const page = await client.list({ ...(cursor ? { cursor } : {}) });
        assertCurrent();
        records.push(...page.items);
        if (!page.nextCursor || page.nextCursor === cursor) {
          break;
        }
        cursor = page.nextCursor;
      }
      const value = await legacyChatNavigation(records, agents);
      assertCurrent();
      return value;
    }
    catch (error: unknown) {
      if (error instanceof CanonicalShellChatRequestError && (error.status === 401 || error.status === 403)) {
        throw new ChatNavigationAuthorityRevoked();
      }
      throw error;
    }
  }, [client, scope, generation]);
  const navigation = useChatNavigation({ scope: scope ?? transient, generation, load, persistence, eventSource });
  // Layout runs before the store's passive initial load. Capture the actual
  // store at request start, so replacing this binding cannot retarget a read.
  useLayoutEffect(() => { loadAuthority.current = { client, scope, generation, store: navigation.store }; }, [client, scope, generation, navigation.store]);
  return navigation;
}
