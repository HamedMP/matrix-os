import { useSyncExternalStore } from "react";
import { Keyboard } from "react-native";

function subscribe(onChange: () => void): () => void {
  const shown = Keyboard.addListener("keyboardDidShow", onChange);
  const hidden = Keyboard.addListener("keyboardDidHide", onChange);
  return () => {
    shown.remove();
    hidden.remove();
  };
}

const isVisible = () => Keyboard.isVisible();

/** Whether the on-screen keyboard is showing. */
export function useKeyboardVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible);
}
