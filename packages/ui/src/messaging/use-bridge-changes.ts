import { useEffect, useEffectEvent, useRef } from "react";
import {
  MESSAGING_BRIDGE_CHANGED_EVENT,
  MessagingBridgeChangedEventSchema,
  type MessagingBridgeChangedEvent,
} from "@matrix-os/contracts/messaging-bridge";

/**
 * Surface adapters pass their owner WebSocket subscription. It receives every
 * parsed socket frame and returns an unsubscribe function, or `null` when the
 * surface has no live socket right now (the shared panel then polls).
 */
export type MessagingBridgeSubscribe = (listener: (frame: unknown) => void) => (() => void) | null;

export const MESSAGING_BRIDGE_FALLBACK_POLL_MS = 10_000;

/** Parses one socket frame; anything other than a valid change event is ignored. */
export function parseBridgeChange(frame: unknown): MessagingBridgeChangedEvent | null {
  if (typeof frame !== "object" || frame === null || (frame as { type?: unknown }).type !== MESSAGING_BRIDGE_CHANGED_EVENT) return null;
  const parsed = MessagingBridgeChangedEventSchema.safeParse(frame);
  return parsed.success ? parsed.data : null;
}

/**
 * Calls `onChange` for each valid `messages:changed` event, or with `null`
 * (refresh everything) every 10 s while the tab is visible when no socket is
 * available or the surface reports it disconnected (`connected === false`).
 * Change events sent during a disconnect are lost, so reconnecting refreshes
 * everything once.
 */
export function useMessagingBridgeChanges(
  subscribe: MessagingBridgeSubscribe | undefined,
  onChange: (event: MessagingBridgeChangedEvent | null) => void,
  enabled = true,
  connected = true,
): void {
  const notify = useEffectEvent((event: MessagingBridgeChangedEvent | null) => onChange(event));
  const missedEvents = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = connected
      ? subscribe?.((frame) => {
        const event = parseBridgeChange(frame);
        if (event) notify(event);
      }) ?? null
      : null;
    if (unsubscribe) {
      if (missedEvents.current) {
        missedEvents.current = false;
        notify(null);
      }
      return unsubscribe;
    }
    if (!connected) missedEvents.current = true;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") notify(null);
    }, MESSAGING_BRIDGE_FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [subscribe, enabled, connected]);
}
