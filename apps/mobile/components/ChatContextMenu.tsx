import type { ReactElement } from "react";
import type { PressableProps } from "react-native";

import { chatMenuOpenHaptic, useChatMenuActions, type ChatMenuFit } from "./chat-menu-actions";
import { ChatMenuTrigger } from "./ChatMenuTrigger";

export type { ChatMenuFit } from "./chat-menu-actions";

export interface ChatContextMenuProps {
  /** The chat the menu acts on. None for a chat that does not exist yet. */
  chatId?: string | null;
  /** The message a long press was on, for Copy text and Share. None for a chat as a whole. */
  messageText?: string | null;
  /** How what it opens on sits in its row. Across the row when omitted. */
  fit?: ChatMenuFit;
  /** The corners of what it opens on, so it keeps its shape as iOS lifts it. */
  cornerRadius?: number;
  /** Room around content without a shape of its own, inside what iOS lifts. It does not move the content. */
  inset?: number;
  /**
   * Fills what iOS lifts, for content without a background of its own: the
   * screen's colour, so it shows only as the content lifts, over its shadow.
   */
  backgroundColor?: string;
  children: ReactElement<PressableProps>;
}

/** Native Mobile's long-press equivalent of the shared Chat context menu. */
export function ChatContextMenu({
  chatId,
  messageText,
  fit = "fill",
  cornerRadius = 0,
  inset = 0,
  backgroundColor,
  children,
}: ChatContextMenuProps) {
  const text = messageText?.trim() || null;
  const actions = useChatMenuActions(chatId || null, text);
  if (actions.length === 0) return children;
  return (
    <ChatMenuTrigger
      title={text ? "Message" : "Chat"}
      actions={actions}
      onOpen={chatMenuOpenHaptic}
      fit={fit}
      cornerRadius={cornerRadius}
      inset={inset}
      backgroundColor={backgroundColor}
    >
      {children}
    </ChatMenuTrigger>
  );
}
