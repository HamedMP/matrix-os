import { EMPTY_TERMINAL_EVENTS_STATE, reduceTerminalEvents, type TerminalEventsState } from "./events-state.js";

const PING_MS = 20_000;
// The gateway bounds each tab to about 1 KiB, and the runtime to 10 000 live tabs plus
// 1 024 finished ones, so a snapshot stays below this.
const MAX_FRAME_CHARS = 16 * 1024 * 1024;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface TerminalEventsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * Keeps one live `/ws/terminal/events` connection and its state: pings so the
 * server keeps it, reconnects with backoff, and resnapshots after `missed`.
 */
export function createTerminalEventsClient(options: {
  url: () => string | null | Promise<string | null>;
  createSocket: (url: string) => TerminalEventsSocket;
  onState: (state: TerminalEventsState) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setRepeat?: (callback: () => void, ms: number) => unknown;
  clearRepeat?: (handle: unknown) => void;
}) {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const setRepeat = options.setRepeat ?? ((callback, ms) => setInterval(callback, ms));
  const clearRepeat = options.clearRepeat ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let state = EMPTY_TERMINAL_EVENTS_STATE;
  let socket: TerminalEventsSocket | null = null;
  let ping: unknown = null;
  let retry: unknown = null;
  let backoff = RECONNECT_MIN_MS;
  let stopped = false;

  const publish = (next: TerminalEventsState) => {
    if (next === state) return;
    state = next;
    options.onState(state);
  };

  const scheduleReconnect = () => {
    if (stopped || retry !== null) return;
    retry = setTimer(() => { retry = null; connect(); }, backoff);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };

  let connecting = false;
  const connect = () => {
    if (stopped || connecting) return;
    connecting = true;
    void Promise.resolve().then(options.url).then((url) => {
      connecting = false;
      if (stopped || socket) return;
      if (!url) { scheduleReconnect(); return; }
      open(url);
    }, (error: unknown) => {
      connecting = false;
      console.warn("[terminal-events] url unavailable", error instanceof Error ? error.name : "unknown_error");
      scheduleReconnect();
    });
  };

  const open = (url: string) => {
    let opened: TerminalEventsSocket;
    try {
      opened = options.createSocket(url);
    } catch (error: unknown) {
      console.warn("[terminal-events] connect failed", error instanceof Error ? error.name : "unknown_error");
      scheduleReconnect();
      return;
    }
    socket = opened;
    opened.onopen = () => {
      backoff = RECONNECT_MIN_MS;
      ping = setRepeat(() => {
        try { opened.send(JSON.stringify({ type: "ping" })); }
        catch (error: unknown) { console.warn("[terminal-events] ping failed", error instanceof Error ? error.name : "unknown_error"); }
      }, PING_MS);
    };
    // react-doctor-disable-next-line react-doctor/postmessage-origin-risk -- a WebSocket from this client's own authenticated URL, not window.postMessage
    opened.onmessage = (event) => {
      if (socket !== opened || stopped) return;
      if (typeof event.data !== "string" || event.data.length > MAX_FRAME_CHARS) return;
      let frame: unknown;
      try { frame = JSON.parse(event.data); }
      catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        return;
      }
      publish(reduceTerminalEvents(state, frame));
    };
    opened.onclose = () => {
      // Only the current socket of a running client may change state: a socket
      // closed by stop() or replaced must not restore old tabs.
      if (socket !== opened) return;
      if (ping !== null) clearRepeat(ping);
      ping = null;
      socket = null;
      if (stopped) return;
      publish({ ...state, connected: false });
      scheduleReconnect();
    };
    opened.onerror = () => {
      console.warn("[terminal-events] socket error");
    };
  };

  return {
    start() {
      stopped = false;
      if (!socket) connect();
    },
    stop() {
      stopped = true;
      if (retry !== null) clearTimer(retry);
      if (ping !== null) clearRepeat(ping);
      retry = null;
      ping = null;
      socket?.close(1000, "client stopped");
      socket = null;
    },
    getState: () => state,
  };
}
