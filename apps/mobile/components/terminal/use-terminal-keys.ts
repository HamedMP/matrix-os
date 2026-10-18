import { useCallback, useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

import { applyTerminalCtrlModifier } from "@/lib/terminal-key-input";

/**
 * State of the key rows under a terminal: whether the keyboard is up, whether
 * the extra key pages are open, and the sticky ctrl. Typed text and keys from
 * the rows both pass through here on their way to `send`.
 */
export function useTerminalKeys(send: (data: string) => void, focusKeyboard: () => void) {
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());
  const [expanded, setExpanded] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);

  useEffect(() => {
    // iOS reports the keyboard before it moves, so the key rows move with it;
    // Android only reports it afterwards.
    const shown = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setKeyboardVisible(true),
    );
    const hidden = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => {
        setKeyboardVisible(false);
        // With the keyboard down only the main key row stays.
        setExpanded(false);
      },
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  // Text from the emulator. An armed ctrl turns the next letter typed into its
  // control key, and Return folds the extra keys away to make room for the
  // answer. Replies the emulator makes to the program (cursor position, focus
  // and the like) start with ESC, which the on-screen keyboard never sends;
  // they go out as they are and leave ctrl and the keys alone.
  const sendTyped = useCallback((data: string) => {
    if (data.startsWith("\x1b")) {
      send(data);
      return;
    }
    let typed = data;
    if (ctrlArmed) {
      setCtrlArmed(false);
      typed = applyTerminalCtrlModifier(data) ?? data;
    }
    if (typed === "\r") setExpanded(false);
    send(typed);
  }, [ctrlArmed, send]);

  // A key from the rows, or one the surface presses for a tap, is sent as it
  // is; it does not combine with ctrl and uses it up.
  const sendKey = useCallback((data: string) => {
    setCtrlArmed(false);
    send(data);
  }, [send]);

  const toggleCtrl = useCallback(() => {
    // The letter to combine comes from the keyboard, so arming brings it up.
    if (!ctrlArmed) focusKeyboard();
    setCtrlArmed(!ctrlArmed);
  }, [ctrlArmed, focusKeyboard]);

  return { keyboardVisible, expanded, setExpanded, ctrlArmed, toggleCtrl, sendTyped, sendKey };
}
