import { createContext, use, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useNavigation } from "expo-router";

import { useShowChatScreen } from "@/lib/use-shell-navigation";

/** Asks for the chat screen after the tabs' next change, and returns the way to take that back. */
type ShowChatAfterClosing = () => () => void;

const ChatHandoffContext = createContext<ShowChatAfterClosing | null>(null);

/**
 * Shows the chat screen once a screen of the Agents tab has closed itself.
 * The tabs drop a switch that arrives in the same render as a change to their
 * own state, which holds the stack of each tab, so the switch has to wait
 * until they have taken the closing in. It waits here, in the tab's layout,
 * because the screen that asked is gone by then.
 */
export function ChatHandoffProvider({ children }: { children: ReactNode }) {
  // The layout of a tab is a screen of the tabs: this hears their state.
  const navigation = useNavigation();
  const showChatScreen = useShowChatScreen();
  const waiting = useRef(false);

  useEffect(() => navigation.addListener("state", () => {
    if (!waiting.current) return;
    waiting.current = false;
    showChatScreen();
  }), [navigation, showChatScreen]);

  const showChatAfterNextChange = useCallback(() => {
    waiting.current = true;
    return () => {
      waiting.current = false;
    };
  }, []);

  return <ChatHandoffContext value={showChatAfterNextChange}>{children}</ChatHandoffContext>;
}

/**
 * Asks for the chat screen after the tabs' next change, to be called just
 * before the screen closes itself. A screen that turns out not to have closed
 * takes the request back, or the next unrelated change would show the chat.
 * Null outside the Agents tab, where nothing would hear the change.
 */
export function useShowChatAfterClosing(): ShowChatAfterClosing | null {
  return use(ChatHandoffContext);
}
