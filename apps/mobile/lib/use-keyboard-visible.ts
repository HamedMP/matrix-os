import { useSyncExternalStore } from "react";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// The keyboard controller says when the keyboard starts to move, on Android as
// on iOS, so what depends on it changes with the keyboard rather than after it
// has landed. React Native's own Android events arrive only once it has shown,
// on the next layout pass.

// What the last event said, while anything listens.
let lastSaid: boolean | null = null;
let listening = 0;

function subscribe(onChange: () => void): () => void {
  listening += 1;
  const shown = KeyboardEvents.addListener("keyboardWillShow", () => {
    lastSaid = true;
    onChange();
  });
  const hidden = KeyboardEvents.addListener("keyboardWillHide", () => {
    lastSaid = false;
    onChange();
  });
  return () => {
    shown.remove();
    hidden.remove();
    listening -= 1;
    // Nothing hears the keyboard now, so the next reader asks the controller.
    if (listening === 0) lastSaid = null;
  };
}

const isVisible = () => lastSaid ?? KeyboardController.isVisible();

/** Whether the on-screen keyboard is showing or on its way. */
export function useKeyboardVisible(): boolean {
  return useSyncExternalStore(subscribe, isVisible);
}
