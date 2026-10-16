import { useSyncExternalStore } from "react";
import { Keyboard, Platform } from "react-native";

// iOS says when the keyboard starts to move, so what depends on it changes
// with the keyboard rather than after it has landed. Android only says once it
// has shown or hidden.
const showEvent = () => (Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow");
const hideEvent = () => (Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide");

// What the last event said, while anything listens. React Native's own answer
// only changes once the keyboard has landed.
let lastSaid: boolean | null = null;
let listening = 0;

function subscribe(onChange: () => void): () => void {
  listening += 1;
  const shown = Keyboard.addListener(showEvent(), () => {
    lastSaid = true;
    onChange();
  });
  const hidden = Keyboard.addListener(hideEvent(), () => {
    lastSaid = false;
    onChange();
  });
  return () => {
    shown.remove();
    hidden.remove();
    listening -= 1;
    // Nothing hears the keyboard now, so the next reader asks React Native.
    if (listening === 0) lastSaid = null;
  };
}

const isVisible = () => lastSaid ?? Keyboard.isVisible();

/** Whether the on-screen keyboard is showing, or on iOS on its way. */
export function useKeyboardVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible);
}
