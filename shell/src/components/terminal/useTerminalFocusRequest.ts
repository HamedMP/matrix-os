"use client";

import { useEffect, type RefObject } from "react";

interface FocusableTerminal {
  focus(): void;
}

function isFocusableTerminal(value: unknown): value is FocusableTerminal {
  return (
    typeof value === "object" &&
    value !== null &&
    "focus" in value &&
    typeof value.focus === "function"
  );
}

export function useTerminalFocusRequest(
  terminalRef: RefObject<unknown>,
  focusRequestId: number,
  isFocused: boolean,
  suppressNativeKeyboard: boolean,
) {
  useEffect(() => {
    if (
      isFocused &&
      !suppressNativeKeyboard &&
      isFocusableTerminal(terminalRef.current)
    ) {
      terminalRef.current.focus();
    }
  }, [focusRequestId, isFocused, suppressNativeKeyboard, terminalRef]);
}
