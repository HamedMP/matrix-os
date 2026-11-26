import { EventEmitter } from "node:events";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";
import { LOCAL_TERMINAL_VERSION } from "@desktop/shared/local-terminals";

/** An in-memory herdr-core speaking the documented protocol. */
export function fakeCore(options: { version?: string; generation?: number; hello?: Record<string, unknown> } = {}) {
  const socket = new EventEmitter() as EventEmitter & { write(data: Buffer | string): void; destroy(): void; destroyed: boolean };
  const decoder = new HcFrameDecoder();
  const sent = { plain: [] as string[], calls: [] as Array<{ id: number; method: string; params: Record<string, unknown> }>, frames: [] as Array<{ channel: number; kind: number; payload: Buffer }> };
  const reply = (id: number, body: Record<string, unknown>) =>
    socket.emit("data", encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...body }))));
  let framed = false;
  let autoReply: ((call: { id: number; method: string; params: Record<string, unknown> }) => void) | null = null;
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (data) => {
    if (!framed) {
      sent.plain.push(String(data));
      framed = true;
      queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, ...(options.hello ?? { result: {
        version: options.version ?? LOCAL_TERMINAL_VERSION, generation: options.generation ?? 1, framed: true, features: ["framed", "attach"], methods: [], core: {},
      } }) })}\n`)));
      return;
    }
    for (const frame of decoder.push(data as Buffer)) {
      if (frame.channel === 0 && frame.kind === HC_FRAME.DATA) {
        const call = JSON.parse(frame.payload.toString("utf8"));
        sent.calls.push(call);
        autoReply?.(call);
      } else sent.frames.push({ ...frame, payload: Buffer.from(frame.payload) });
    }
  };
  /** The bytes of a reply, for tests that deliver several frames in one read. */
  const replyBytes = (id: number, body: Record<string, unknown>) =>
    encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...body })));
  return { socket, sent, reply, replyBytes, onCall: (handler: NonNullable<typeof autoReply>) => { autoReply = handler; },
    stream: (channel: number, kind: number, payload: Buffer) => socket.emit("data", encodeFrame(channel, kind, payload)) };
}

/**
 * The bytes herdr-core sends a viewer that attaches with history, in the
 * order ghostty-vt's `paint` builds them (herdr-core 0.1.19,
 * crates/ghostty-vt/src/lib.rs `paint`, viewers.rs `first_paint`): cancel,
 * soft reset and `ESC[H ESC[2J`, the history lines pushed up into the
 * viewer's scrollback, then the screen. `ESC[2J` clears the screen only, so
 * whatever scrollback the viewer already holds stays.
 */
export function corePaint(options: { history: string[]; screen: string[]; rows: number }): string {
  let paint = "\x18\x1b[!p\x1b[?2026l\x1b[?1004l\x1b[?2004l\x1b[?1049l\x1b[H\x1b[2J";
  if (options.history.length > 0) {
    paint += options.history.join("\r\n");
    paint += `\x1b[0m\r\n${"\n".repeat(options.rows)}`;
    paint += "\x1b[H\x1b[2J";
  }
  paint += options.screen.join("\r\n");
  return `${paint}\x1b[?9001l`;
}
