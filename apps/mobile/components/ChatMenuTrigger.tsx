import { cloneElement } from "react";
import { Alert, type AlertButton } from "react-native";

import type { ChatMenuTriggerProps } from "./chat-menu-actions";

// Android's alert holds three buttons at most. With fewer actions there is
// room for Cancel; a tap outside or Back closes it either way.
const ALERT_BUTTON_LIMIT = 3;

/** Android's chat menu: an alert opened by a long press. iOS draws a native context menu instead. */
export function ChatMenuTrigger({ title, actions, onOpen, children }: ChatMenuTriggerProps) {
  return cloneElement(children, {
    onLongPress: () => {
      onOpen();
      const buttons: AlertButton[] = actions.map((action) => ({
        text: action.label,
        style: action.id === "item" && action.destructive ? "destructive" : undefined,
        onPress: action.onSelect,
      }));
      if (buttons.length < ALERT_BUTTON_LIMIT) buttons.push({ text: "Cancel", style: "cancel" });
      Alert.alert(title, undefined, buttons, { cancelable: true });
    },
  });
}
