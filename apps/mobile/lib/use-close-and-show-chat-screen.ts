import { useCallback } from "react";
import { useNavigation } from "expo-router";

import { useShowChatScreen } from "@/lib/use-shell-navigation";

/**
 * Closes the current screen when its stack has something behind it, then
 * shows the chat screen, so the tab is on its list the next time it is opened.
 * Navigation calls apply in order once the render has committed, so the switch
 * to the Chats tab follows the closing.
 */
export function useCloseAndShowChatScreen(): () => void {
  const navigation = useNavigation();
  const showChatScreen = useShowChatScreen();
  return useCallback(() => {
    if (navigation.isFocused() && (navigation.getState()?.routes.length ?? 0) > 1) navigation.goBack();
    showChatScreen();
  }, [navigation, showChatScreen]);
}
