// One `/ws/terminal/events` connection per Electron renderer, for the selected
// Matrix computer: drives remote tab status dots and attention toasts. The
// trusted core injects the gateway Bearer header on the upgrade, so the URL
// carries no credential.
import { create } from "zustand";
import {
  createTerminalEventsClient,
  EMPTY_TERMINAL_EVENTS_STATE,
  type TerminalEventsSocket,
  type TerminalEventsState,
} from "@matrix-os/ui/terminal-agents";

export const useTerminalAgentEvents = create<TerminalEventsState>()(() => EMPTY_TERMINAL_EVENTS_STATE);

/** Same origin and runtime selection as the kernel `/ws` socket. */
export function buildTerminalEventsWsUrl(baseUrl: string, runtimeSlot: string): string {
  const url = `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws/terminal/events`;
  return runtimeSlot === "primary" ? url : `${url}?runtime=${encodeURIComponent(runtimeSlot)}`;
}

let stopActive: (() => void) | null = null;

/**
 * Connect to the given computer's events stream, replacing any previous
 * connection. Returns a function that closes it and clears the state.
 */
export function wireTerminalAgentEvents(options: {
  baseUrl: string;
  runtimeSlot: string;
  createSocket?: (url: string) => TerminalEventsSocket;
}): () => void {
  stopActive?.();
  const url = buildTerminalEventsWsUrl(options.baseUrl, options.runtimeSlot);
  // A browser WebSocket has every member the client uses; DOM handler
  // signatures are only narrower in their `this` and event types.
  const createSocket = options.createSocket ?? ((target: string) => new WebSocket(target) as unknown as TerminalEventsSocket);
  let current = true;
  const client = createTerminalEventsClient({
    url: () => url,
    createSocket,
    onState: (state) => { if (current) useTerminalAgentEvents.setState(state); },
  });
  const stop = () => {
    if (!current) return;
    current = false;
    client.stop();
    if (stopActive === stop) stopActive = null;
    useTerminalAgentEvents.setState(EMPTY_TERMINAL_EVENTS_STATE);
  };
  stopActive = stop;
  client.start();
  return stop;
}
