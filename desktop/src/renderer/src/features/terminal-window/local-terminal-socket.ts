// Adapts a local terminal (held by the trusted core) to the socket contract
// the shared terminal view already speaks, so local and cloud tabs render and
// behave identically. Keystrokes and output cross IPC only; nothing here can
// reach the network.
import { invoke, onEvent } from "../../lib/operator";
import type { ShellSocketEvents } from "../../lib/shell-socket";
import type { SocketControl } from "../terminal/attach-manager";
import { LOCAL_TERMINAL_MAX_ACK_COUNT, LOCAL_TERMINAL_SESSION_PREFIX } from "../../../../shared/local-terminals";

const INPUT_CHUNK_CHARS = 32_768;
// Output can reach the window before the attach call returns its id (the
// history replay does). It is held, bounded, until the id is known.
const MAX_EARLY_EVENTS = 256;
const MAX_EARLY_ATTACHMENTS = 16;
const DEFAULT_SIZE = { cols: 100, rows: 30 };

/** The end of the next input chunk, never between the halves of one character. */
export function inputChunkEnd(value: string, start: number): number {
  const end = Math.min(start + INPUT_CHUNK_CHARS, value.length);
  if (end >= value.length) return end;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return splitsPair ? end - 1 : end;
}

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
  // Early output that did not fit the buffer, per attachment. It is not shown,
  // but its credit must still go back or the terminal would stall. At most a
  // few attachments can be starting at once.
  const earlyDropped = new Map<number, number>();
  // Attachments reported closed before this socket knew its own id: a shell
  // can end in the moment between the core attaching and the reply arriving.
  const earlyClosed = new Set<number>();
  let unacknowledged = 0;
  let ackScheduled = false;

  // Tells the trusted core how much output was taken, in one call per burst.
  // The core holds back the program's output until it hears this.
  const acknowledge = (events_ = 1) => {
    unacknowledged += events_;
    if (ackScheduled) return;
    ackScheduled = true;
    queueMicrotask(() => {
      ackScheduled = false;
      let remaining = unacknowledged;
      unacknowledged = 0;
      if (attachId === null || released) return;
      // A hidden window draws in large slices, so one burst can cover more
      // events than a single acknowledgement may carry.
      while (remaining > 0) {
        const count = Math.min(remaining, LOCAL_TERMINAL_MAX_ACK_COUNT);
        remaining -= count;
        void invoke("local-terminal:ack", { attachId, count }).catch((error: unknown) => warn("ack", error));
      }
    });
  };

  // Credit goes back once the view has drawn the output, not when it was
  // merely handed over: a program that prints faster than the screen can
  // draw is slowed down instead of filling the window's memory.
  // A window nobody is looking at must not slow the program down: browsers
  // throttle hidden pages, so there the output is acknowledged on arrival.
  const deliver = (data: string) => {
    let done = false;
    const drawn = () => {
      if (done) return;
      done = true;
      acknowledge();
    };
    events.onOutput(data, ++seq, drawn);
    if (document.visibilityState === "hidden") drawn();
  };

  const release = () => {
    if (released) return;
    released = true;
    for (const stop of unsubscribe) stop();
    unsubscribe = [];
    early = [];
    earlyDropped.clear();
    earlyClosed.clear();
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
    for (let offset = 0; offset < data.length;) {
      // Binary input is one byte per character and can be cut anywhere.
      const end = binary ? Math.min(offset + INPUT_CHUNK_CHARS, data.length) : inputChunkEnd(data, offset);
      void invoke("local-terminal:input", { attachId: current, data: data.slice(offset, end), ...(binary ? { binary: true } : {}) })
        .then((result) => { if (!result.ok) lost(current); })
        .catch((error: unknown) => warn("input", error));
      offset = end;
    }
  };

  return {
    connect() {
      events.onState("connecting");
      // Subscribe before attaching so the first paint cannot be missed.
      unsubscribe = [
        onEvent("local-terminal:output", (event) => {
          if (event.attachId === attachId) deliver(event.data);
          else if (attachId === null && !released) {
            if (early.length < MAX_EARLY_EVENTS) early.push(event);
            else if (earlyDropped.size < MAX_EARLY_ATTACHMENTS || earlyDropped.has(event.attachId)) {
              earlyDropped.set(event.attachId, (earlyDropped.get(event.attachId) ?? 0) + 1);
            }
          }
        }),
        onEvent("local-terminal:closed", (event) => {
          if (attachId === null && !released) {
            if (earlyClosed.size < MAX_EARLY_ATTACHMENTS) earlyClosed.add(event.attachId);
            return;
          }
          if (event.attachId !== attachId) return;
          attachId = null;
          events.onState("ended");
          release();
        }),
      ];
      // The size the core was asked for; the pane may be resized before it answers.
      const requested = size;
      void invoke("local-terminal:attach", { id, ...requested })
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
          const dropped = earlyDropped.get(result.attachId) ?? 0;
          earlyDropped.clear();
          if (dropped > 0) acknowledge(dropped);
          // It already ended: its last output is shown, then it reads as ended
          // instead of as a live terminal that takes no input.
          const alreadyClosed = earlyClosed.has(result.attachId);
          earlyClosed.clear();
          if (alreadyClosed) {
            attachId = null;
            events.onState("ended");
            release();
            return;
          }
          // Resized while attaching: the shell must learn the size now, not at the next resize.
          if (size.cols !== requested.cols || size.rows !== requested.rows) {
            const attached = result.attachId;
            void invoke("local-terminal:resize", { attachId: attached, ...size })
              .then((resized) => { if (!resized.ok) lost(attached); })
              .catch((error: unknown) => warn("resize", error));
          }
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
