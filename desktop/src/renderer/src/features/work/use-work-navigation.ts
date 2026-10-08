import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatNavigationAuthorityRevoked, markChatNavigation, clearChatNavigationScopes, legacyChatNavigation, useChatNavigation, type ChatNavigationPersistence } from "@matrix-os/ui";
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
  const load = useCallback(async (): Promise<CanonicalChatNavigationResponse> => {
    if (!client) {
      throw new Error("NavigationUnavailable");
    }
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
      const records = await loadWorkRailChats(client);
      return await legacyChatNavigation(records, client.agents);
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
  return useChatNavigation({ scope, generation: String(generation), load, persistence, eventSource, active: active && Boolean(client) });
}
