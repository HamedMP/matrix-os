// Adapts a local terminal (held by the trusted core) to the socket contract
// the shared terminal view already speaks, so local and cloud tabs render and
// behave identically. Output, typing and acknowledgements travel over the
// attachment's own port, held by the preload (spec 2701 layer 6); output stays
// bytes all the way to xterm. Nothing here can reach the network.
import { invoke } from "../../lib/operator";
import type { ShellSocketEvents } from "../../lib/shell-socket";
import type { SocketControl } from "../terminal/attach-manager";
import { LOCAL_TERMINAL_MAX_ACK_COUNT, LOCAL_TERMINAL_SESSION_PREFIX } from "../../../../shared/local-terminals";
import type { LocalTerminalStream } from "../../../../shared/local-terminal-stream-bridge";

const INPUT_CHUNK_CHARS = 32_768;
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

/** How the shared terminal view reaches local terminals: by session prefix, repainted by the core on attach. */
export const LOCAL_TERMINAL_SOCKETS = {
  prefix: LOCAL_TERMINAL_SESSION_PREFIX,
  create: (sessionName: string, events: ShellSocketEvents) => createLocalTerminalSocket(sessionName, events),
  repaintsOnAttach: true,
} as const;

export function createLocalTerminalSocket(sessionName: string, events: ShellSocketEvents): SocketControl {
  const id = sessionName.slice(LOCAL_TERMINAL_SESSION_PREFIX.length);
  let size = DEFAULT_SIZE;
  let attachId: number | null = null;
  let stream: LocalTerminalStream | null = null;
  let seq = 0;
  let released = false;
  let unacknowledged = 0;
  let ackScheduled = false;
  // Typing waiting to be sent, in order; each entry is one kind of input.
  let pending: Array<{ data: string; binary: boolean }> = [];
  let flushScheduled = false;

  // Tells the trusted core how much output was taken, in one message per burst.
  // The core holds back the program's output until it hears this.
  const acknowledge = (events_ = 1) => {
    unacknowledged += events_;
    if (ackScheduled) return;
    ackScheduled = true;
    queueMicrotask(() => {
      ackScheduled = false;
      let remaining = unacknowledged;
      unacknowledged = 0;
      if (!stream || released) return;
      // A hidden window draws in large slices, so one burst can cover more
      // events than a single acknowledgement may carry.
      while (remaining > 0) {
        const count = Math.min(remaining, LOCAL_TERMINAL_MAX_ACK_COUNT);
        remaining -= count;
        stream.ack(count);
      }
    });
  };

  // Credit goes back once the view has drawn the output, not when it was
  // merely handed over: a program that prints faster than the screen can
  // draw is slowed down instead of filling the window's memory.
  // A window nobody is looking at must not slow the program down: browsers
  // throttle hidden pages, so there the output is acknowledged on arrival.
  const deliver = (data: Uint8Array) => {
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
    pending = [];
    stream?.close();
    stream = null;
    if (attachId !== null) {
      const current = attachId;
      attachId = null;
      void invoke("local-terminal:detach", { attachId: current }).catch((error: unknown) => warn("detach", error));
    }
  };

  // The trusted core no longer holds this attachment: stop accepting typing
  // that would go nowhere, and let the view offer to reconnect.
  const ended = () => {
    if (released) return;
    attachId = null;
    events.onState("ended");
    release();
  };
  const lost = (id: number) => { if (attachId === id) ended(); };

  // Everything typed in one turn (a paste, a burst of key events) leaves as
  // one message per kind of input instead of one call per chunk.
  const flush = () => {
    flushScheduled = false;
    const batch = pending;
    pending = [];
    if (!stream || released) return;
    for (const { data, binary } of batch) {
      for (let offset = 0; offset < data.length;) {
        // Binary input is one byte per character and can be cut anywhere.
        const end = binary ? Math.min(offset + INPUT_CHUNK_CHARS, data.length) : inputChunkEnd(data, offset);
        stream.input(data.slice(offset, end), binary);
        offset = end;
      }
    }
  };
  const send = (data: string, binary: boolean) => {
    if (attachId === null || released || data.length === 0) return;
    const last = pending.at(-1);
    if (last && last.binary === binary) last.data += data;
    else pending.push({ data, binary });
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  };

  return {
    connect() {
      events.onState("connecting");
      // The size the core was asked for; the pane may be resized before it answers.
      const requested = size;
      void invoke("local-terminal:attach", { id, ...requested })
        .then((result) => {
          if (released) {
            if (result.ok) void invoke("local-terminal:detach", { attachId: result.attachId }).catch((error: unknown) => warn("detach", error));
            return;
          }
          if (!result.ok) { ended(); return; }
          const attached = result.attachId;
          attachId = attached;
          // Output that arrived before this reply waits in the port, in order,
          // and so does the end of a shell that exited meanwhile.
          stream = window.operator.localTerminalStream?.(attached, { output: deliver, closed: () => lost(attached) }) ?? null;
          if (!stream) { warn("attach", new Error("no terminal stream")); release(); events.onState("ended"); return; }
          events.onOwnershipChange?.("writer");
          // The core sizes a terminal to its latest viewer: the attach size is now its grid.
          events.onCanonicalSize?.(requested);
          events.onState("attached");
          // The core's first paint is the whole terminal: start from nothing,
          // so nothing the view still shows ends up above or below it.
          events.onRepaint?.();
          // Resized while attaching: the shell must learn the size now, not at the next resize.
          if (size.cols !== requested.cols || size.rows !== requested.rows) {
            const wanted = size;
            void invoke("local-terminal:resize", { attachId: attached, ...wanted })
              .then((resized) => { if (!resized.ok) lost(attached); else if (attachId === attached && !released) events.onCanonicalSize?.(wanted); })
              .catch((error: unknown) => warn("resize", error));
          }
        })
        .catch((error: unknown) => { warn("attach", error); ended(); });
    },
    sendInput: (data) => send(data, false),
    sendBinary: (data) => send(data, true),
    focus: (focused) => { if (!released) stream?.focus(focused); },
    facts: (display) => { if (!released) stream?.facts(display); },
    resize(cols, rows) {
      size = { cols: Math.min(500, Math.max(20, Math.floor(cols))), rows: Math.min(200, Math.max(5, Math.floor(rows))) };
      if (attachId !== null && !released) {
        const current = attachId;
        const wanted = size;
        void invoke("local-terminal:resize", { attachId: current, ...wanted })
          // Accepted: the xterm takes the new grid. Without this a local pane only scaled after a split or window resize.
          .then((result) => { if (!result.ok) lost(current); else if (attachId === current && !released && size === wanted) events.onCanonicalSize?.(wanted); })
          .catch((error: unknown) => warn("resize", error));
      }
    },
    detach: release,
    dispose: release,
  };
}
