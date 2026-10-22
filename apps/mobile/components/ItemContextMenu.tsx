import type { ReactElement } from "react";
import type { PressableProps } from "react-native";

import { chatMenuOpenHaptic, type ItemMenuAction } from "./chat-menu-actions";
import { ChatMenuTrigger } from "./ChatMenuTrigger";

export type { ItemMenuAction } from "./chat-menu-actions";

export interface ItemContextMenuProps {
  /** Heads the menu where the platform shows a title: the item's name. */
  title: string;
  /** What the item can do. None draws the row with no menu. */
  actions: readonly ItemMenuAction[];
  /** The corners of the row, so it keeps its shape as iOS lifts it. */
  cornerRadius?: number;
  /** Fills what iOS lifts, for a row without a background of its own: the screen's colour. */
  backgroundColor?: string;
  children: ReactElement<PressableProps>;
}

/**
 * The menu a long press on a row opens, with the actions that item already
 * offers elsewhere on its screen: the same native menu, and haptic, as a chat's.
 */
export function ItemContextMenu({ title, actions, cornerRadius = 0, backgroundColor, children }: ItemContextMenuProps) {
  if (actions.length === 0) return children;
  return (
    <ChatMenuTrigger
      title={title}
      actions={actions}
      onOpen={chatMenuOpenHaptic}
      fit="fill"
      cornerRadius={cornerRadius}
      inset={0}
      backgroundColor={backgroundColor}
    >
      {children}
    </ChatMenuTrigger>
  );
}
