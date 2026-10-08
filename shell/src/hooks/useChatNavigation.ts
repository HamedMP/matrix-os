"use client";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ChatNavigationAuthorityRevoked, clearChatNavigationScopes, createBrowserChatNavigationPersistence, legacyChatNavigation, useChatNavigation, type CanonicalChatEventSource } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { CanonicalShellChatRequestError } from "@/lib/canonical-chat-client";
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
  const load = useCallback(async () => {
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
      const records: CanonicalChatRecord[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < 10; index++) {
        const page = await client.list({ ...(cursor ? { cursor } : {}) });
        records.push(...page.items);
        if (!page.nextCursor || page.nextCursor === cursor) {
          break;
        }
        cursor = page.nextCursor;
      }
      return await legacyChatNavigation(records, client.agents);
    }
    catch (error: unknown) {
      if (error instanceof CanonicalShellChatRequestError && (error.status === 401 || error.status === 403)) {
        throw new ChatNavigationAuthorityRevoked();
      }
      throw error;
    }
  }, [client]);
  return useChatNavigation({ scope: scope ?? transient, generation, load, persistence, eventSource });
}
