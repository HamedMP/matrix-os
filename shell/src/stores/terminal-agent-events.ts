import { create } from "zustand";
import {
  createTerminalEventsClient,
  EMPTY_TERMINAL_EVENTS_STATE,
  type TerminalEventsSocket,
  type TerminalEventsState,
} from "@matrix-os/ui/terminal-agents";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";

interface TerminalAgentEventsStore extends TerminalEventsState {
  /** Start the shared connection; returns a release function. */
  retain(): () => void;
}

let client: ReturnType<typeof createTerminalEventsClient> | null = null;
let holders = 0;

/**
 * One `/ws/terminal/events` connection per shell document, shared by every
 * surface that shows terminal status (Terminal sidebar, attention toasts).
 */
export const useTerminalAgentEvents = create<TerminalAgentEventsStore>((set) => ({
  ...EMPTY_TERMINAL_EVENTS_STATE,
  retain() {
    holders += 1;
    if (!client && typeof window !== "undefined" && typeof WebSocket !== "undefined") {
      client = createTerminalEventsClient({
        url: () => buildAuthenticatedWebSocketUrl("/ws/terminal/events"),
        // A browser WebSocket has every member the client uses; DOM handler
        // signatures are only narrower in their `this` and event types.
        createSocket: (url) => new WebSocket(url) as unknown as TerminalEventsSocket,
        onState: (state) => set(state),
      });
    }
    client?.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders -= 1;
      if (holders === 0) {
        client?.stop();
        client = null;
        set(EMPTY_TERMINAL_EVENTS_STATE);
      }
    };
  },
}));
