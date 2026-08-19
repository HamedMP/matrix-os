"use client";

import { useEffect, type RefObject } from "react";

interface FocusableTerminal {
  focus(): void;
}

export function useTerminalFocusRequest<T extends FocusableTerminal>(
  terminalRef: RefObject<T | null>,
  focusRequestId: number,
  isFocused: boolean,
  suppressNativeKeyboard: boolean,
) {
  useEffect(() => {
    if (isFocused && !suppressNativeKeyboard) {
      terminalRef.current?.focus();
    }
  }, [focusRequestId, isFocused, suppressNativeKeyboard, terminalRef]);
}
