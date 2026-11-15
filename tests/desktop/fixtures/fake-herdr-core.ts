import { EventEmitter } from "node:events";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@desktop/main/local-terminals/hc-protocol";

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
        version: options.version ?? "0.1.19", generation: options.generation ?? 1, framed: true, features: ["framed", "attach"], methods: [], core: {},
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
