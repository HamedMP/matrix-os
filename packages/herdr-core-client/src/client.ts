// A minimal herdr-core client. Only the Electron main process uses it: over
// the bundled core's private Unix socket, and over the byte stream of
// `herdr-core connect` on a Matrix computer (spec 651 J6). The first exchange
// is the handshake; nothing else is spoken to a core that is not accepted.
import { z } from "zod/v4";
import { encodeCredit, encodeFacts, encodeFocus, encodeFrame, encodeResize, HC_FRAME, HcFrameDecoder, type HcDisplayFacts } from "#protocol";

const CALL_TIMEOUT_MS = 5_000;
const MAX_PENDING_CALLS = 64;
const MAX_STREAMS = 32;
const MAX_HELLO_BYTES = 64 * 1024;
/** Scrollback lines the core replays on attach when the caller names none. */
const DEFAULT_ATTACH_HISTORY = 2_000;

const HelloSchema = z.object({
  version: z.string().max(32),
  generation: z.number().int(),
  framed: z.literal(true),
  features: z.array(z.string().max(64)).max(64),
  methods: z.array(z.string().max(64)).max(256).optional(),
});
/** What a core says about itself in the handshake. */
export interface HcHello { version: string; generation: number; features: string[]; methods: string[] }
/**
 * Which core is accepted: the app's own core by its exact version, a core the
 * app did not start by a rule. Protocol generation 1 is required either way.
 */
export type HcAcceptance = { expectedVersion: string } | { accepts(hello: HcHello): boolean };
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
const AttachedSchema = z.object({ channel: z.number().int().min(1).max(0xffff_ffff), terminal: z.unknown().optional() });
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
  /** The viewer gained or lost focus; programs that asked for focus reports get them. */
  focus(focused: boolean): void;
  /** The viewer's colours and cell size, for the program's queries. */
  facts(display: HcDisplayFacts): void;
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
  /** A scoped caller can pin the specific process this channel reported at attachment time. */
  acceptTerminal?(terminal: unknown): boolean;
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
  /**
   * `history` is how many scrollback lines the core replays first (default 2,000).
   * `observe` attaches watch-only: the core never takes this viewer's typing or
   * size, so it cannot resize the program (herdr-core `terminal.attach` param).
   */
  attach(params: { terminal: string; cols: number; rows: number; history?: number; observe?: boolean; selection_revision?: string }, handlers: HcStreamHandlers): Promise<HcStream>;
  onDisconnect(listener: () => void): void;
  close(): void;
}

/** What the other end sends is untrusted: unreadable JSON is a protocol error. */
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) throw new HcProtocolError();
    throw error;
  }
}

export function connectHc(options: { open(): HcSocket; timeoutMs?: number } & HcAcceptance): Promise<HcConnection> {
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
        const result = await call("terminal.attach", { ...params, history: params.history ?? DEFAULT_ATTACH_HISTORY }, timeoutMs, (reply) => {
          const attached = AttachedSchema.parse(reply);
          // A channel that is still open here was reused: trust neither stream.
          if (streams.has(attached.channel)) throw new HcProtocolError();
          if (handlers.acceptTerminal && !handlers.acceptTerminal(attached.terminal)) {
            socket.write(encodeFrame(attached.channel, HC_FRAME.CLOSE, Buffer.alloc(0)));
            throw new HcCallError("not_found");
          }
          streams.set(attached.channel, handlers);
        });
        const { channel } = AttachedSchema.parse(result);
        return {
          write: (data) => { if (!closed && streams.has(channel)) socket.write(encodeFrame(channel, HC_FRAME.DATA, data)); },
          resize: (cols, rows) => { if (!closed && streams.has(channel)) socket.write(encodeResize(channel, cols, rows)); },
          focus: (focused) => { if (!closed && streams.has(channel)) socket.write(encodeFocus(channel, focused)); },
          facts: (display) => { if (!closed && streams.has(channel)) socket.write(encodeFacts(channel, display)); },
          close: () => {
            if (!streams.delete(channel) || closed) return;
            socket.write(encodeFrame(channel, HC_FRAME.CLOSE, Buffer.alloc(0)));
          },
        };
      },
      // A connection can end in the same read as its handshake, before anyone
      // listens: a late listener is told at once, so no caller keeps a dead one.
      onDisconnect: (listener) => { if (closed) listener(); else disconnectListeners.push(listener); },
      close: () => teardown(new Error("local terminal runtime closed")),
    };

    const onFrame = (channel: number, kind: number, payload: Buffer) => {
      if (channel === 0) {
        if (kind !== HC_FRAME.DATA) return;
        const reply = ReplySchema.safeParse(parseJson(payload));
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
          const reply = ReplySchema.safeParse(parseJson(hello.subarray(0, newline)));
          const parsed = reply.success ? HelloSchema.safeParse(reply.data.result) : null;
          // Whatever answered is not a core this client can talk to; that is
          // different from a healthy core of another version.
          if (!parsed?.success) throw new HcProtocolError();
          const { version: found, generation, features, methods = [] } = parsed.data;
          const accepted = "accepts" in options
            ? options.accepts({ version: found, generation, features, methods })
            : found === options.expectedVersion;
          if (generation !== 1 || !accepted) throw new HcVersionMismatchError(found);
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
