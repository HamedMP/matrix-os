import { useCallback } from "react";
import { useNavigation, useRouter } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";

import { CHATS_TAB_ROUTE, CHAT_SCREEN_HREF, tabScreenHref } from "@/lib/shell-routes";

/** Opens the side panel from a screen inside the tabs. */
export function useOpenSidePanel(): () => void {
  const navigation = useNavigation();
  return useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);
}

/**
 * Switches to the Chats tab and shows the chat screen, from a screen in
 * another tab, closing whatever was left open above it in the Chats tab.
 */
export function useShowChatScreen(): () => void {
  const navigation = useNavigation();
  const router = useRouter();
  return useCallback(() => {
    // Switching tabs by name keeps whatever the Chats tab has open, and
    // dismissing to the chat screen then closes it. Navigating to the chat
    // screen's href would push a second chat screen on top instead.
    navigation.navigate(CHATS_TAB_ROUTE as never);
    router.dismissTo(CHAT_SCREEN_HREF as never);
  }, [navigation, router]);
}

/** Switches to the Terminal or Settings tab, from a screen in another tab. */
export function useShowTab(): (tab: Parameters<typeof tabScreenHref>[0]) => void {
  const router = useRouter();
  return useCallback((tab) => {
    router.navigate(tabScreenHref(tab) as never);
  }, [router]);
}
