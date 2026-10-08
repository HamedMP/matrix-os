"use client";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ChatAgentClient } from "@matrix-os/ui";
import type { useShellChatNavigation } from "./useChatNavigation";

/** An authority epoch changes even when the transport and Clerk session do not. */
export function useCanonicalChatAuthority(navigation: ReturnType<typeof useShellChatNavigation>, agents: ChatAgentClient | undefined, scope?: string, generation?: string) {
  const store = navigation.store;
  const epoch = store?.getAuthorityEpoch() ?? 0;
  const blocked = epoch > 0 && !navigation.fresh && navigation.updatedAt === 0;
  const identity = JSON.stringify([scope ?? null, generation ?? null, epoch]);
  const token = useMemo(() => ({ store, identity, blocked }), [store, identity, blocked]);
  const current = useRef(token);
  const mounted = useRef(true);
  useLayoutEffect(() => { current.current = token; mounted.current = true; return () => { mounted.current = false; }; }, [token]);
  const isCurrent = useCallback(() => current.current === token && mounted.current && !blocked
    && (store?.getAuthorityEpoch() ?? 0) === epoch
    && !(epoch > 0 && !store?.getSnapshot().fresh && store?.getSnapshot().updatedAt === 0),
  [token, blocked, store, epoch]);
  const summaryClient = useMemo(() => {
    if (!agents || blocked) return undefined;
    // Summary WeakMap caches get a new identity; action clients keep the identity
    // used by the shared hosted Agents navigation. Guard queued and late reads.
    const guard = <Args extends unknown[], Value>(read: (...args: Args) => Promise<Value>) => async (...args: Args) => {
      if (!isCurrent()) throw new Error("ChatAuthorityChanged");
      const value = await read(...args);
      if (!isCurrent()) throw new Error("ChatAuthorityChanged");
      return value;
    };
    return { ...agents, list: guard(agents.list), bots: agents.bots ? { ...agents.bots,
      ensureDirectChat: guard(agents.bots.ensureDirectChat), directChat: guard(agents.bots.directChat), directBot: guard(agents.bots.directBot),
      tasks: guard(agents.bots.tasks), interactions: guard(agents.bots.interactions),
    } : undefined };
  }, [agents, blocked, isCurrent]);
  return { identity, isCurrent, agentClient: blocked ? undefined : agents, summaryClient };
}
