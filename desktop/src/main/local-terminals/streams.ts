// One MessagePort per local terminal attachment (spec 2701 layer 6). Output
// leaves the core as bytes and reaches the Terminal window's preload as bytes,
// with no text decoding and no event routed through every listener in the
// window. The window acknowledges and types over the same port; whatever it
// sends is validated here again, as every IPC request is.
import type { HcDisplayFacts } from "@matrix-os/herdr-core-client/protocol";
import type { HcSessionSink } from "@matrix-os/herdr-core-client/sessions";
import {
  LOCAL_TERMINAL_PORT_CHANNEL, LOCAL_TERMINAL_STREAM_CLOSED, LocalTerminalStreamRequestSchema, type LocalTerminalStreamRequest,
} from "../../shared/local-terminals";

/** The trusted core's end of a port: Electron's MessagePortMain. */
export interface LocalTerminalMainPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}

/** Where ports are handed over: the Terminal window's webContents. */
export interface LocalTerminalPortTarget<Port> {
  postMessage(channel: string, message: unknown, transfer: Port[]): void;
}

export interface LocalTerminalStreamHost {
  acknowledge(attachId: number, count: number): boolean;
  input(attachId: number, data: string, binary: boolean): boolean;
  focus(attachId: number, focused: boolean): boolean;
  facts(attachId: number, display: HcDisplayFacts): boolean;
}

function forward(host: LocalTerminalStreamHost, attachId: number, request: LocalTerminalStreamRequest): boolean {
  switch (request.type) {
    case "ack": return host.acknowledge(attachId, request.count);
    case "input": return host.input(attachId, request.data, request.binary === true);
    case "focus": return host.focus(attachId, request.focused);
    case "facts": {
      const { type: _type, ...display } = request;
      return host.facts(attachId, display);
    }
  }
}

/** A window's webContents while it can still take a port, else null. */
export function liveContents<Contents extends { isDestroyed(): boolean }>(
  win: { isDestroyed(): boolean; webContents: Contents } | null | undefined,
): Contents | null {
  return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : null;
}

// Ports exist only for live attachments, which the attachment slots bound;
// this is a backstop that closes the oldest if that ever fails.
const MAX_PORTS = 32;

export function createLocalTerminalStreams<WindowPort>(options: {
  /** The Terminal window, or null while it is closed. */
  target(): LocalTerminalPortTarget<WindowPort> | null;
  createChannel(): { port1: LocalTerminalMainPort; port2: WindowPort };
}) {
  // Insertion-ordered, so the first entry is the oldest.
  const ports = new Map<number, LocalTerminalMainPort>();
  let host: LocalTerminalStreamHost | null = null;

  function close(attachId: number, tellWindow: boolean): void {
    const port = ports.get(attachId);
    if (!port) return;
    ports.delete(attachId);
    if (tellWindow) port.postMessage(LOCAL_TERMINAL_STREAM_CLOSED);
    port.close();
  }

  function receive(attachId: number, data: unknown): void {
    const request = LocalTerminalStreamRequestSchema.safeParse(data);
    if (!request.success || !host) return;
    try {
      const live = forward(host, attachId, request.data);
      // The core no longer holds it: the window stops typing into nothing.
      if (!live) close(attachId, true);
    } catch (error: unknown) {
      console.warn("[local-terminals] stream message failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }

  /** The attachment's port, created and handed to the window the first time it is needed. */
  function open(attachId: number): LocalTerminalMainPort | null {
    const existing = ports.get(attachId);
    if (existing) return existing;
    const target = options.target();
    if (!target) return null;
    if (ports.size >= MAX_PORTS) {
      const oldest = ports.keys().next().value;
      if (oldest !== undefined) close(oldest, true);
    }
    const { port1, port2 } = options.createChannel();
    port1.on("message", (event) => receive(attachId, event.data));
    port1.start();
    ports.set(attachId, port1);
    target.postMessage(LOCAL_TERMINAL_PORT_CHANNEL, { attachId }, [port2]);
    return port1;
  }

  const sink: HcSessionSink = {
    outputBytes(attachId, data) {
      const port = open(attachId);
      // No window to show it: it still counts as taken, so the program is not stalled.
      if (!port) { host?.acknowledge(attachId, 1); return; }
      // Structured clone copies a view's whole backing buffer, which for a
      // frame inside a socket read is the entire read: post only these bytes.
      port.postMessage(data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice());
    },
    closed(attachId) {
      if (!ports.has(attachId)) open(attachId);
      close(attachId, true);
    },
  };

  return {
    sink,
    /** The host whose attachments these ports carry; set once it exists. */
    bind(next: LocalTerminalStreamHost): void { host = next; },
    /** Makes sure the window has the attachment's port before it learns the id. */
    open: (attachId: number): boolean => open(attachId) !== null,
    /** The window detached: its port goes too. */
    release: (attachId: number): void => close(attachId, false),
    /** The window closed, reloaded or crashed. */
    releaseAll(): void { for (const attachId of [...ports.keys()]) close(attachId, false); },
    /** How many ports are open. */
    size: (): number => ports.size,
  };
}

export type LocalTerminalStreams = ReturnType<typeof createLocalTerminalStreams<unknown>>;
