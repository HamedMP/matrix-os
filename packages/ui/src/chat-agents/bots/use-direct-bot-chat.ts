import { useEffect, useState } from "react";
import type { ChatAgentClient } from "../client.js";

export type DirectBotBindingStatus = "loading" | "error" | "bot" | "ordinary";
/** Unknown identity never grants ordinary-Chat provider or context controls. */
export function useDirectBotBinding(chatId: string | undefined, client: ChatAgentClient | undefined, resolvedId?: string | null) {
  const bots = client?.bots;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ chatId: string; bots: NonNullable<ChatAgentClient["bots"]>; attempt:number; id: string | null; failed:boolean } | null>(null);
  useEffect(() => {
    if (resolvedId !== undefined || !chatId || !bots) return;
    let current = true;
    void bots.directBot(chatId).then((id) => {
      if (current) setResult({ chatId, bots, attempt, id, failed:false });
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Direct bot lookup failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setResult({ chatId, bots, attempt, id:null, failed:true });
    });
    return () => { current = false; };
  }, [chatId, bots, resolvedId, attempt]);
  let agentId:string|null = null;
  let status:DirectBotBindingStatus = "ordinary";
  if (chatId && bots) {
    if (resolvedId !== undefined) { agentId = resolvedId; status = agentId ? "bot" : "ordinary"; }
    else if (result?.chatId === chatId && result.bots === bots && result.attempt === attempt) {
      agentId=result.id; status=result.failed ? "error" : agentId ? "bot" : "ordinary";
    } else status="loading";
  }
  return { agentId, status, loading:status === "loading", error:status === "error" ? "Chat identity could not be loaded. Try again." : null,
    retry: () => setAttempt(value => value + 1) };
}
/** Compatibility wrapper for consumers that only need a resolved Bot ID. */
export function useDirectBotChat(chatId: string | undefined, client: ChatAgentClient | undefined, resolvedId?: string | null) {
  return useDirectBotBinding(chatId, client, resolvedId).agentId;
}
