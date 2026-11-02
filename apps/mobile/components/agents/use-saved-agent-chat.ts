import { useEffect, useState } from "react";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import type { useActiveGateway } from "@/lib/queries/use-active-gateway";
import { fetchAgentDirectChat } from "@/lib/requests/bots";

export type SavedAgentChat = {chatId: string; scope: string};

/** Schedule history is a read of an existing Chat, never get-or-create. */
export function useSavedAgentChat(agentId: string, target: SavedAgentChat | undefined, gateway: ReturnType<typeof useActiveGateway>) {
  const scope = `${gateway.userId}:${gateway.computerKey}`;
  const chatId = target?.chatId, expectedScope = target?.scope;
  const valid = expectedScope === scope && CanonicalChatIdSchema.safeParse(chatId).success;
  const key = JSON.stringify([scope, agentId, chatId, expectedScope, gateway.ready]);
  const [result, setResult] = useState<{key: string; chatId: string | null; failed: boolean} | null>(null);
  const [attempt, setAttempt] = useState(0);
  const session = gateway.session;
  useEffect(() => {
    if (!valid || !chatId || !gateway.ready) return;
    let current = true;
    void (async () => {
      try {
        const auth = await session();
        if (!current) return;
        if (!auth) throw new Error("Chat unavailable");
        const bound = await fetchAgentDirectChat(auth.token, auth.gatewayUrl, agentId);
        if (current) setResult({key, chatId: bound === chatId ? chatId : null, failed: bound !== chatId});
      } catch (failure: unknown) {
        console.warn("[mobile-schedules] Saved Chat unavailable", failure instanceof Error ? failure.name : "UnknownError");
        if (current) setResult({key, chatId: null, failed: true});
      }
    })();
    return () => { current = false; };
  }, [valid, chatId, gateway.ready, agentId, key, session, attempt]);
  const accepted = valid && result?.key === key ? result : null;
  return {
    chatId: accepted?.chatId ?? null,
    failed: Boolean(target && (!valid || gateway.isComputerError || accepted?.failed)),
    retry: () => { setResult(null); setAttempt(value => value + 1); },
  };
}
