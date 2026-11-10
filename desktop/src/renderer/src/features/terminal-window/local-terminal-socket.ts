// Adapts a local terminal (held by the trusted core) to the socket contract
// the shared terminal view already speaks, so local and cloud tabs render and
// behave identically. Keystrokes and output cross IPC only; nothing here can
// reach the network.
import { invoke, onEvent } from "../../lib/operator";
import type { ShellSocketEvents } from "../../lib/shell-socket";
import type { SocketControl } from "../terminal/attach-manager";
import { LOCAL_TERMINAL_SESSION_PREFIX } from "../../../../shared/local-terminals";

const INPUT_CHUNK_CHARS = 32_768;
// Output can reach the window before the attach call returns its id (the
// history replay does). It is held, bounded, until the id is known.
const MAX_EARLY_EVENTS = 256;
const DEFAULT_SIZE = { cols: 100, rows: 30 };

function warn(action: string, error: unknown): void {
  console.warn(`[local-terminal] ${action} failed:`, error instanceof Error ? error.name : "UnknownError");
}

export function createLocalTerminalSocket(sessionName: string, events: ShellSocketEvents): SocketControl {
  const id = sessionName.slice(LOCAL_TERMINAL_SESSION_PREFIX.length);
  let size = DEFAULT_SIZE;
  let attachId: number | null = null;
  let seq = 0;
  let released = false;
  let unsubscribe: Array<() => void> = [];
  let early: Array<{ attachId: number; data: string }> = [];
  let unacknowledged = 0;
  let ackScheduled = false;

  // Tells the trusted core how much output was taken, in one call per burst.
  // The core holds back the program's output until it hears this.
  const acknowledge = () => {
    unacknowledged += 1;
    if (ackScheduled) return;
    ackScheduled = true;
    queueMicrotask(() => {
      ackScheduled = false;
      const count = unacknowledged;
      unacknowledged = 0;
      if (attachId === null || released || count === 0) return;
      void invoke("local-terminal:ack", { attachId, count }).catch((error: unknown) => warn("ack", error));
    });
  };

  const deliver = (data: string) => {
    events.onOutput(data, ++seq);
    acknowledge();
  };

  const release = () => {
    if (released) return;
    released = true;
    for (const stop of unsubscribe) stop();
    unsubscribe = [];
    early = [];
    if (attachId !== null) {
      const current = attachId;
      attachId = null;
      void invoke("local-terminal:detach", { attachId: current }).catch((error: unknown) => warn("detach", error));
    }
  };

  // The trusted core no longer holds this attachment: stop accepting typing
  // that would go nowhere, and let the view offer to reconnect.
  const lost = (id: number) => {
    if (attachId !== id || released) return;
    attachId = null;
    events.onState("ended");
    release();
  };

  const send = (data: string, binary: boolean) => {
    if (attachId === null || released) return;
    const current = attachId;
    for (let offset = 0; offset < data.length; offset += INPUT_CHUNK_CHARS) {
      void invoke("local-terminal:input", { attachId: current, data: data.slice(offset, offset + INPUT_CHUNK_CHARS), ...(binary ? { binary: true } : {}) })
        .then((result) => { if (!result.ok) lost(current); })
        .catch((error: unknown) => warn("input", error));
    }
  };

  return {
    connect() {
      events.onState("connecting");
      // Subscribe before attaching so the first paint cannot be missed.
      unsubscribe = [
        onEvent("local-terminal:output", (event) => {
          if (event.attachId === attachId) deliver(event.data);
          else if (attachId === null && !released && early.length < MAX_EARLY_EVENTS) early.push(event);
        }),
        onEvent("local-terminal:closed", (event) => {
          if (event.attachId !== attachId) return;
          attachId = null;
          events.onState("ended");
          release();
        }),
      ];
      void invoke("local-terminal:attach", { id, ...size })
        .then((result) => {
          if (released) {
            if (result.ok) void invoke("local-terminal:detach", { attachId: result.attachId }).catch((error: unknown) => warn("detach", error));
            return;
          }
          if (!result.ok) { events.onState("ended"); release(); return; }
          attachId = result.attachId;
          events.onOwnershipChange?.("writer");
          events.onState("attached");
          const held = early;
          early = [];
          for (const event of held) if (event.attachId === result.attachId) deliver(event.data);
        })
        .catch((error: unknown) => { warn("attach", error); if (!released) { events.onState("ended"); release(); } });
    },
    sendInput: (data) => send(data, false),
    sendBinary: (data) => send(data, true),
    resize(cols, rows) {
      size = { cols: Math.min(500, Math.max(20, Math.floor(cols))), rows: Math.min(200, Math.max(5, Math.floor(rows))) };
      if (attachId !== null && !released) {
        const current = attachId;
        void invoke("local-terminal:resize", { attachId: current, ...size })
          .then((result) => { if (!result.ok) lost(current); })
          .catch((error: unknown) => warn("resize", error));
      }
    },
    detach: release,
    dispose: release,
  };
}
