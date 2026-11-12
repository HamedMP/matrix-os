import { createContext, useContext } from "react";

export type SideChatDraftRequest = { id: number; chatId: string; text: string };
export const SideChatDraftContext = createContext<{
  pending: SideChatDraftRequest | null;
  request(chatId: string, text: string): void;
  consume(id: number): void;
} | null>(null);
export function useSideChatDraft() { return useContext(SideChatDraftContext); }
