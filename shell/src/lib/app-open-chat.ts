import { useEffect, useRef } from "react";
import { AppChatReplySchema, AppIdentitySchema } from "@matrix-os/contracts";

const APP_OPEN_CHAT_EVENT = "matrix:app-open-chat";

/**
 * Apps can post to the parent directly, so the host checks the app's own Chat
 * access with its stamped identity before moving the owner's active Chat.
 */
export async function openChatFromApp(app: string, chatId: string, gatewayUrl: string): Promise<void> {
  const response = await fetch(`${gatewayUrl}/api/bridge/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: AppIdentitySchema.parse(app), input: { kind: "chats", request: { op: "get", chatId, limit: 1 } } }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Chat navigation is unavailable");
  const reply = AppChatReplySchema.parse(await response.json());
  if (!reply.ok) throw new Error("Chat navigation is unavailable");
  window.dispatchEvent(new CustomEvent<string>(APP_OPEN_CHAT_EVENT, { detail: chatId }));
}

/** The OS view that owns the Chat surface registers how a validated Chat opens. */
export function useAppOpenChat(open: (chatId: string) => void): void {
  const latest = useRef(open);
  useEffect(() => { latest.current = open; });
  useEffect(() => {
    const listener = (event: Event) => {
      const chatId = (event as CustomEvent<unknown>).detail;
      if (typeof chatId === "string") latest.current(chatId);
    };
    window.addEventListener(APP_OPEN_CHAT_EVENT, listener);
    return () => window.removeEventListener(APP_OPEN_CHAT_EVENT, listener);
  }, []);
}
