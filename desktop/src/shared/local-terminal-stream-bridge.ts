// The Terminal window's preload end of local terminal ports (spec 2701 layer
// 6). The trusted core hands the preload one MessagePort per attachment; the
// page never holds a port, only this narrow handle. Output is passed on as
// bytes; what the page sends is validated here and again in main.
import { z } from "zod/v4";
import {
  LOCAL_TERMINAL_MAX_OUTPUT_BYTES, LOCAL_TERMINAL_PORT_CHANNEL, LocalTerminalPortSchema, LocalTerminalStreamRequestSchema,
} from "./local-terminals";

interface StreamPort {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface IpcRendererLike {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): unknown;
}

export interface LocalTerminalStreamHandlers {
  output(data: Uint8Array): void;
  closed(): void;
}

export interface LocalTerminalStream {
  input(data: string, binary: boolean): void;
  ack(count: number): void;
  close(): void;
}

// Ports the window has not claimed yet, and claims waiting for their port:
// both last only for the moment between the core attaching and the page
// learning its id. Past the cap the oldest is dropped.
const MAX_UNCLAIMED = 16;
// Messages the page sends before its port arrives.
const MAX_OUTBOX = 256;
const AttachIdSchema = LocalTerminalPortSchema.shape.attachId;
const ClosedSchema = z.strictObject({ type: z.literal("closed") });

// By tag, not `instanceof`: a cloned message may come from another realm.
function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isPort(value: unknown): value is StreamPort {
  const port = value as Partial<StreamPort> | null;
  return typeof port?.postMessage === "function" && typeof port.start === "function" && typeof port.close === "function";
}

function evictOldest<V>(map: Map<number, V>, drop: (value: V) => void): void {
  if (map.size < MAX_UNCLAIMED) return;
  const oldest = map.keys().next().value;
  if (oldest === undefined) return;
  const value = map.get(oldest)!;
  map.delete(oldest);
  drop(value);
}

export function createLocalTerminalStreamBridge(ipc: IpcRendererLike) {
  const unclaimed = new Map<number, StreamPort>();
  const waiting = new Map<number, (port: StreamPort) => void>();

  ipc.on(LOCAL_TERMINAL_PORT_CHANNEL, (event, payload) => {
    const port = (event as { ports?: unknown[] } | null)?.ports?.[0];
    const parsed = LocalTerminalPortSchema.safeParse(payload);
    if (!isPort(port)) return;
    if (!parsed.success) { port.close(); return; }
    const { attachId } = parsed.data;
    const claim = waiting.get(attachId);
    if (claim) { waiting.delete(attachId); claim(port); return; }
    unclaimed.get(attachId)?.close();
    unclaimed.delete(attachId);
    evictOldest(unclaimed, (stale) => stale.close());
    unclaimed.set(attachId, port);
  });

  /** The handle for one attachment's port, whether or not the port has arrived yet. */
  return function localTerminalStream(attachId: unknown, handlers: LocalTerminalStreamHandlers): LocalTerminalStream | null {
    const id = AttachIdSchema.safeParse(attachId);
    if (!id.success || typeof handlers?.output !== "function" || typeof handlers.closed !== "function") return null;
    let port: StreamPort | null = null;
    let outbox: unknown[] = [];
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      outbox = [];
      if (waiting.get(id.data) === connect) waiting.delete(id.data);
      if (port) { port.onmessage = null; port.close(); }
    };
    const connect = (arrived: StreamPort) => {
      if (finished) { arrived.close(); return; }
      port = arrived;
      arrived.onmessage = ({ data }) => {
        if (finished) return;
        if (isBytes(data)) {
          if (data.byteLength <= LOCAL_TERMINAL_MAX_OUTPUT_BYTES) handlers.output(data);
          return;
        }
        if (ClosedSchema.safeParse(data).success) { finish(); handlers.closed(); }
      };
      arrived.start();
      for (const message of outbox) arrived.postMessage(message);
      outbox = [];
    };
    const ready = unclaimed.get(id.data);
    if (ready) { unclaimed.delete(id.data); connect(ready); }
    else {
      evictOldest(waiting, () => undefined);
      waiting.set(id.data, connect);
    }

    const send = (request: unknown) => {
      if (finished) return;
      const parsed = LocalTerminalStreamRequestSchema.safeParse(request);
      if (!parsed.success) return;
      if (port) port.postMessage(parsed.data);
      else if (outbox.length < MAX_OUTBOX) outbox.push(parsed.data);
    };
    return {
      input: (data, binary) => send(binary ? { type: "input", data, binary: true } : { type: "input", data }),
      ack: (count) => send({ type: "ack", count }),
      close: finish,
    };
  };
}
