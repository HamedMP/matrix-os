import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChatNavigationAuthorityRevoked, markChatNavigation, clearChatNavigationScopes, legacyChatNavigation, useChatNavigation, type ChatNavigationPersistence, type ChatAgentClient } from "@matrix-os/ui";
import type { CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { AppError } from "../../../../shared/app-error";
import type { CanonicalChatClient, CanonicalChatEventSource } from "../../lib/canonical-chat-client";
import { loadWorkRailChats } from "./work-rail-data";
type Fence = {
  scope: string;
  authGeneration: number;
};
type NavigationStore = NonNullable<ReturnType<typeof useChatNavigation>["store"]>;
// One cache identity per live store authority; WeakMap lifetimes follow the bounded store registry.
const legacyAuthorities = new WeakMap<NavigationStore, { source: ChatAgentClient; epoch: number; client: ChatAgentClient }>();
function legacyClient(store: NavigationStore, epoch: number, source?: ChatAgentClient) {
  if (!source) return undefined;
  let authority = legacyAuthorities.get(store);
  if (!authority || authority.source !== source || authority.epoch !== epoch) {
    authority = { source, epoch, client: { ...source } };
    legacyAuthorities.set(store, authority);
  }
  return authority.client;
}
const ephemeral = new WeakMap<CanonicalChatClient, string>();
function ephemeralScope(client: CanonicalChatClient) {
  let key = ephemeral.get(client);
  if (!key) {
    key = `desktop-test:${crypto.randomUUID()}`;
    ephemeral.set(client, key);
  }
  return key;
}
let previousOwner: string | null = null;
useConnection.subscribe((current) => {
  const owner = current.status === "signed-in" ? `${current.platformHost}:${current.userId}` : null;
  if (previousOwner && previousOwner !== owner) {
    clearChatNavigationScopes();
  }
  previousOwner = owner;
});
export function useWorkNavigation(client: CanonicalChatClient | null, eventSource: Pick<CanonicalChatEventSource, "subscribe"> | undefined, active: boolean) {
  const userId = useConnection(state => state.userId);
  const host = useConnection(state => state.platformHost);
  const handle = useConnection(state => state.handle);
  const slot = useConnection(state => state.runtimeSlot);
  const generation = useConnection(state => state.authGeneration);
  const signedIn = useConnection(state => state.status === "signed-in");
  const identity = JSON.stringify([signedIn, userId, host, handle, slot, generation]);
  const [context, setContext] = useState<{
    identity: string;
    fence: Fence | null;
  } | null>(null);
  useEffect(() => {
    let live = true;
    if (!window.operator || !signedIn) {
      return () => {
        live = false;
      };
    }
    void invoke("navigation-cache:context", {}).then(value => {
      if (live && value.authGeneration === generation) {
        markChatNavigation("scope-ready");
        setContext({ identity, fence: value.scope ? { scope: value.scope, authGeneration: value.authGeneration } : null });
      }
    }).catch((error: unknown) => console.warn("[chat-navigation] Context unavailable:", error instanceof Error ? error.name : "UnknownError"));
    return () => {
      live = false;
    };
  }, [identity, generation, signedIn]);
  const fence = context?.identity === identity ? context.fence : null;
  const persistence = useMemo<ChatNavigationPersistence | undefined>(() => fence ? {
    load: async () => (await invoke("navigation-cache:load", fence)).snapshot,
    save: async (snapshot) => {
      await invoke("navigation-cache:save", { ...fence, snapshot });
    },
    clear: async () => {
      await invoke("navigation-cache:clear", fence);
    },
  } : undefined, [fence]);
  const currentStore = useRef<NavigationStore | null>(null);
  const load = useCallback(async (): Promise<CanonicalChatNavigationResponse> => {
    if (!client) {
      throw new Error("NavigationUnavailable");
    }
    const store = currentStore.current;
    if (!store) throw new Error("NavigationUnavailable");
    const epoch = store.getAuthorityEpoch();
    const isCurrent = () => currentStore.current === store && store.getAuthorityEpoch() === epoch;
    if (client.navigation) {
      try {
        return await client.navigation();
      }
      catch (error: unknown) {
        if (error instanceof AppError && error.category === "unauthorized") {
          throw new ChatNavigationAuthorityRevoked();
        }
        if (!(error instanceof AppError && error.category === "notFound")) {
          throw error;
        }
      }
    }
    try {
      if (!isCurrent()) throw new Error("NavigationAuthorityChanged");
      const records = await loadWorkRailChats(client);
      if (!isCurrent()) throw new Error("NavigationAuthorityChanged");
      const response = await legacyChatNavigation(records, legacyClient(store, epoch, client.agents));
      if (!isCurrent()) throw new Error("NavigationAuthorityChanged");
      return response;
    }
    catch (error: unknown) {
      if (error instanceof AppError && error.category === "unauthorized") {
        throw new ChatNavigationAuthorityRevoked();
      }
      throw error;
    }
  }, [client]);
  // The no-bridge fallback is used by component harnesses only. Real Electron waits for verified context.
  const scope = fence?.scope ?? (!window.operator && client ? ephemeralScope(client) : null);
  const navigation = useChatNavigation({ scope, generation: String(generation), load, persistence, eventSource, active: active && Boolean(client) });
  useLayoutEffect(() => { currentStore.current = navigation.store; }, [navigation.store]);
  return navigation;
}
