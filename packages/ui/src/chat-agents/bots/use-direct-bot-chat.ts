import { useEffect, useState } from "react";
import type { ChatAgentClient } from "../client.js";

const RETRY_MS = 15_000;

/** null confirms an ordinary Chat; undefined means its routing is still unverified. */
export function useDirectBotChat(chatId: string | undefined, client: ChatAgentClient | undefined, resolvedId?: string | null) {
  const bots = client?.bots;
  const [result, setResult] = useState<{ chatId: string; bots: NonNullable<ChatAgentClient["bots"]>; id: string | null } | null>(null);
  useEffect(() => {
    if (resolvedId !== undefined || !chatId || !bots) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lookup = async () => {
      try {
        const id = await bots.directBot(chatId);
        if (current) setResult({ chatId, bots, id });
      } catch (failure: unknown) {
        console.warn("[chat-agents] Direct bot lookup failed:", failure instanceof Error ? failure.name : "UnknownError");
        // Retain a verified binding for this Chat/client; a failed lookup isn't absence.
      }
      if (current) timer = setTimeout(() => void lookup(), RETRY_MS);
    };
    void lookup();
    return () => { current = false; clearTimeout(timer); };
  }, [chatId, bots, resolvedId]);
  if (!chatId || !bots) return null;
  if (resolvedId !== undefined) return resolvedId;
  return result?.chatId === chatId && result.bots === bots ? result.id : undefined;
}
