"use client";

import { createContext, useContext } from "react";
import type { ChatState } from "@/hooks/useChatState";

const ChatContext = createContext<ChatState | null>(null);

export function ChatProvider({ value, children }: { value: ChatState; children: React.ReactNode }) {
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatState | null {
  return useContext(ChatContext);
}
