"use client";

import { useCallback } from "react";
import { useSocket } from "@/hooks/useSocket";

/** Gateway messages sent when an app is connected, disconnected or expires anywhere, including Settings. */
const CONNECTION_CHANGE_MESSAGES = new Set(["integration:connected", "integration:disconnected", "integration:expired"]);

export function isConnectionChangeMessage(type: string): boolean {
  return CONNECTION_CHANGE_MESSAGES.has(type);
}

/** Subscribes to app connection changes made by any client, for lists that must stay current. */
export function useShellConnectionChanges(): (onChange: () => void) => () => void {
  const { subscribe } = useSocket();
  return useCallback((onChange: () => void) => subscribe((message) => {
    if (isConnectionChangeMessage(message.type)) onChange();
  }), [subscribe]);
}
