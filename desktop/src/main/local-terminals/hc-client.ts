// A minimal client for the bundled herdr-core over its private Unix socket.
// Only the Electron main process uses it. The first exchange is the version
// handshake; nothing else is spoken to a core of another version (spec 651).
import { z } from "zod/v4";
import { encodeCredit, encodeFrame, encodeResize, HC_FRAME, HcFrameDecoder } from "./hc-protocol";

const CALL_TIMEOUT_MS = 5_000;
const MAX_PENDING_CALLS = 64;
const MAX_STREAMS = 32;
const MAX_HELLO_BYTES = 64 * 1024;

const HelloSchema = z.object({
  version: z.string().max(32),
  generation: z.number().int(),
  framed: z.literal(true),
  features: z.array(z.string().max(64)).max(64),
});
const ReplySchema = z.object({
  id: z.number().int().optional(),
  result: z.unknown().optional(),
  error: z.object({ data: z.object({ kind: z.string().max(64) }).optional() }).optional(),
});

export class HcVersionMismatchError extends Error {
  constructor(readonly found: string) { super("local terminal runtime version mismatch"); this.name = "HcVersionMismatchError"; }
}
/** A herdr-core error, reduced to its stable kind. Messages never leave main. */
/** The core answered, but not with a handshake this client understands. */
export class HcProtocolError extends Error {
  constructor() { super("local terminal runtime protocol error"); this.name = "HcProtocolError"; }
}
const AttachedSchema = z.object({ channel: z.number().int().min(1).max(0xffff_ffff) });
export class HcCallError extends Error {
  constructor(readonly kind: string) { super("local terminal call failed"); this.name = "HcCallError"; }
}

export interface HcSocket {
  write(data: Buffer | string): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  destroy(): void;
}

export interface HcStream {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface HcStreamHandlers {
  /**
   * `consumed` returns the chunk's flow-control credit to the core. Call it
   * once the output has really been taken, so a reader that falls behind
   * slows the program down instead of piling output up in memory.
   */
  onData(chunk: Buffer, consumed: () => void): void;
  onClose(): void;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** Runs in the same turn the reply is read, before any frame that follows it. */
  accept?(result: unknown): void;
}

export interface HcConnection {
  readonly version: string;
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  attach(params: { terminal: string; cols: number; rows: number }, handlers: HcStreamHandlers): Promise<HcStream>;
  onDisconnect(listener: () => void): void;
  close(): void;
}

export function connectHc(options: {
  open(): HcSocket;
  expectedVersion: string;
  timeoutMs?: number;
}): Promise<HcConnection> {
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  return new Promise<HcConnection>((resolve, reject) => {
    const socket = options.open();
    const decoder = new HcFrameDecoder();
    // Bounded by MAX_PENDING_CALLS / MAX_STREAMS; both are cleared on disconnect.
    const pending = new Map<number, PendingCall>();
    const streams = new Map<number, HcStreamHandlers>();
    // Attach calls that timed out: a late answer still opens a channel on the
    // core, which must be closed. Bounded like the pending calls.
    const abandonedAttaches = new Set<number>();
    let version = "";
    const disconnectListeners: Array<() => void> = [];
    let hello: Buffer = Buffer.alloc(0);
    let framed = false;
    let closed = false;
    let nextId = 2;
    let settled = false;

    const teardown = (error: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      socket.destroy();
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
      pending.clear();
      abandonedAttaches.clear();
      const open = [...streams.values()];
      streams.clear();
      for (const stream of open) stream.onClose();
      if (!settled) { settled = true; reject(error); return; }
      for (const listener of disconnectListeners) listener();
    };
    const handshakeTimer = setTimeout(() => teardown(new Error("local terminal runtime did not answer")), timeoutMs);

    const call = (
      method: string, params: Record<string, unknown>, callTimeout = timeoutMs, accept?: (result: unknown) => void,
    ): Promise<unknown> => {
      if (closed) return Promise.reject(new Error("local terminal runtime disconnected"));
      if (pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error("local terminal runtime busy"));
      const id = nextId++;
      return new Promise<unknown>((resolveCall, rejectCall) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          if (method === "terminal.attach") {
            if (abandonedAttaches.size >= MAX_PENDING_CALLS) abandonedAttaches.clear();
            abandonedAttaches.add(id);
          }
          rejectCall(new Error("local terminal call timed out"));
        }, callTimeout);
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timer, accept });
        socket.write(encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }))));
      });
    };

    const connection: HcConnection = {
      get version() { return version; },
      call: (method, params, callTimeout) => call(method, params, callTimeout),
      async attach(params, handlers) {
        if (streams.size >= MAX_STREAMS) throw new Error("too many local terminal streams");
        // The channel's first frames (the history replay) can share a socket
        // read with the reply, so the stream is registered as the reply is
        // read, not after this promise resumes.
        const result = await call("terminal.attach", { ...params, history: 2_000 }, timeoutMs, (reply) => {
          const attached = AttachedSchema.parse(reply);
          // A channel that is still open here was reused: trust neither stream.
          if (streams.has(attached.channel)) throw new HcProtocolError();
          streams.set(attached.channel, handlers);
        });
        const { channel } = AttachedSchema.parse(result);
        return {
          write: (data) => { if (!closed && streams.has(channel)) socket.write(encodeFrame(channel, HC_FRAME.DATA, data)); },
          resize: (cols, rows) => { if (!closed && streams.has(channel)) socket.write(encodeResize(channel, cols, rows)); },
          close: () => {
            if (!streams.delete(channel) || closed) return;
            socket.write(encodeFrame(channel, HC_FRAME.CLOSE, Buffer.alloc(0)));
          },
        };
      },
      onDisconnect: (listener) => { disconnectListeners.push(listener); },
      close: () => teardown(new Error("local terminal runtime closed")),
    };

    const onFrame = (channel: number, kind: number, payload: Buffer) => {
      if (channel === 0) {
        if (kind !== HC_FRAME.DATA) return;
        const reply = ReplySchema.safeParse(JSON.parse(payload.toString("utf8")));
        if (!reply.success || reply.data.id === undefined) return;
        const waiting = pending.get(reply.data.id);
        if (!waiting) {
          const late = abandonedAttaches.delete(reply.data.id) ? AttachedSchema.safeParse(reply.data.result) : null;
          if (late?.success && !streams.has(late.data.channel)) {
            socket.write(encodeFrame(late.data.channel, HC_FRAME.CLOSE, Buffer.alloc(0)));
          }
          return;
        }
        pending.delete(reply.data.id);
        clearTimeout(waiting.timer);
        if (reply.data.error) { waiting.reject(new HcCallError(reply.data.error.data?.kind ?? "unknown")); return; }
        try {
          waiting.accept?.(reply.data.result);
        } catch (error: unknown) {
          waiting.reject(error instanceof Error ? error : new HcProtocolError());
          if (error instanceof HcProtocolError) throw error;
          return;
        }
        waiting.resolve(reply.data.result);
        return;
      }
      const stream = streams.get(channel);
      if (!stream) return;
      if (kind === HC_FRAME.DATA) {
        // Credit-based flow control: the reader says when it has consumed this.
        let credited = false;
        stream.onData(payload, () => {
          if (credited || closed || !streams.has(channel)) return;
          credited = true;
          socket.write(encodeCredit(channel, payload.length));
        });
      } else if (kind === HC_FRAME.CLOSE) {
        streams.delete(channel);
        stream.onClose();
      }
    };

    socket.on("data", (chunk) => {
      if (closed) return;
      try {
        if (!framed) {
          hello = Buffer.concat([hello, chunk]);
          const newline = hello.indexOf(10);
          if (newline < 0) {
            if (hello.length > MAX_HELLO_BYTES) throw new Error("handshake too large");
            return;
          }
          const reply = ReplySchema.safeParse(JSON.parse(hello.subarray(0, newline).toString("utf8")));
          const parsed = reply.success ? HelloSchema.safeParse(reply.data.result) : null;
          // Whatever answered is not a core this client can talk to; that is
          // different from a healthy core of another version.
          if (!parsed?.success) throw new HcProtocolError();
          if (parsed.data.generation !== 1 || parsed.data.version !== options.expectedVersion) {
            throw new HcVersionMismatchError(parsed.data.version);
          }
          framed = true;
          clearTimeout(handshakeTimer);
          version = parsed.data.version;
          const rest = hello.subarray(newline + 1);
          hello = Buffer.alloc(0);
          settled = true;
          resolve(connection);
          if (rest.length === 0) return;
          chunk = rest;
        }
        for (const frame of decoder.push(chunk)) onFrame(frame.channel, frame.kind, frame.payload);
      } catch (error: unknown) {
        teardown(error instanceof Error ? error : new Error("local terminal runtime protocol error"));
      }
    });
    socket.on("error", (error) => teardown(error));
    socket.on("close", () => teardown(new Error("local terminal runtime disconnected")));
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { framed: true } })}\n`);
  });
}
