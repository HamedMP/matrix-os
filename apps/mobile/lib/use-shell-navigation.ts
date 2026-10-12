import { useCallback } from "react";
import { useNavigation } from "expo-router";
import { DrawerActions, type NavigationProp, type ParamListBase } from "expo-router/react-navigation";

import { TABS_ROUTE, chatScreenFromAnotherTabParams } from "@/lib/shell-routes";

/** Opens the side panel from a screen inside the tabs. */
export function useOpenSidePanel(): () => void {
  const navigation = useNavigation();
  return useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);
}

/** Switches to the Chats tab and shows the chat screen, from a screen in another tab. */
export function useShowChatScreen(): () => void {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  return useCallback(() => {
    navigation.navigate(TABS_ROUTE, chatScreenFromAnotherTabParams());
  }, [navigation]);
}
