import type { ReactElement } from "react";
import type { PressableProps } from "react-native";

import { chatMenuOpenHaptic, useChatMenuActions } from "./chat-menu-actions";
import { ChatMenuTrigger } from "./ChatMenuTrigger";

export interface ChatContextMenuProps {
  /** The chat the menu acts on. None for a chat that does not exist yet. */
  chatId?: string | null;
  /** The message a long press was on, for Copy text and Share. None for a chat as a whole. */
  messageText?: string | null;
  children: ReactElement<PressableProps>;
}

/** Native Mobile's long-press equivalent of the shared Chat context menu. */
export function ChatContextMenu({ chatId, messageText, children }: ChatContextMenuProps) {
  const text = messageText?.trim() || null;
  const actions = useChatMenuActions(chatId || null, text);
  if (actions.length === 0) return children;
  return (
    <ChatMenuTrigger title={text ? "Message" : "Chat"} actions={actions} onOpen={chatMenuOpenHaptic}>
      {children}
    </ChatMenuTrigger>
  );
}
