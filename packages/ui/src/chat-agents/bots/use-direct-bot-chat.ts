import { useEffect, useState } from "react";
import type { ChatAgentClient } from "../client.js";

/** Scope the result to both Chat and runtime client so stale lookups cannot enable another composer. */
export function useDirectBotChat(chatId: string | undefined, client: ChatAgentClient | undefined, resolvedId?: string | null) {
  const bots = client?.bots;
  const [result, setResult] = useState<{ chatId: string; bots: NonNullable<ChatAgentClient["bots"]>; id: string | null } | null>(null);
  useEffect(() => {
    if (resolvedId !== undefined || !chatId || !bots) return;
    setResult(null);
    let current = true;
    void bots.directBot(chatId).then((id) => {
      if (current) setResult({ chatId, bots, id });
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Direct bot lookup failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setResult({ chatId, bots, id: null });
    });
    return () => { current = false; };
  }, [chatId, bots, resolvedId]);
  if (!chatId || !bots) return null;
  if (resolvedId !== undefined) return resolvedId;
  return result?.chatId === chatId && result.bots === bots ? result.id : null;
}
