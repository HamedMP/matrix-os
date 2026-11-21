import { EventEmitter } from "node:events";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "@matrix-os/herdr-core-client/protocol";

export interface FakeTerminal {
  title: string;
  status: { state: string; msg?: string } | null;
  /** What a viewer is painted with on attach. */
  screen: string;
  input: string[];
  resizes: Array<{ cols: number; rows: number }>;
}

interface Viewer { terminal: string; channel: number; socket: FakeSocket; credits: number }
type FakeSocket = EventEmitter & HcSocket & { destroyed: boolean };

/**
 * A stateful in-memory herdr-core speaking the documented protocol over any
 * number of connections: handshake, terminal.list|attach|kill, stream frames.
 */
export function createFakeHerdrCore(options: { version?: string; methods?: string[]; features?: string[] } = {}) {
  const terminals = new Map<string, FakeTerminal>();
  const viewers: Viewer[] = [];
  const sockets: FakeSocket[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let nextChannel = 1;
  let listFailure: string | null = null;

  const send = (socket: FakeSocket, channel: number, kind: number, payload: Buffer) => {
    if (!socket.destroyed) socket.emit("data", encodeFrame(channel, kind, payload));
  };
  const reply = (socket: FakeSocket, id: number, body: Record<string, unknown>) =>
    send(socket, 0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, ...body })));

  function handle(socket: FakeSocket, call: { id: number; method: string; params: Record<string, unknown> }) {
    calls.push({ method: call.method, params: call.params });
    if (call.method === "terminal.list") {
      if (listFailure) { reply(socket, call.id, { error: { code: -1, message: "x", data: { kind: listFailure } } }); return; }
      reply(socket, call.id, { result: { terminals: [...terminals.entries()].map(([address, terminal]) => ({
        address, state: "live", title: terminal.title, status: terminal.status,
      })) } });
      return;
    }
    if (call.method === "terminal.attach") {
      const id = String(call.params.terminal);
      const terminal = terminals.get(id);
      if (!terminal) { reply(socket, call.id, { error: { code: -1, message: "x", data: { kind: "not_found" } } }); return; }
      const channel = nextChannel++;
      viewers.push({ terminal: id, channel, socket, credits: 0 });
      // The reply and the first paint share one read, as the real core may do.
      socket.emit("data", Buffer.concat([
        encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { channel } }))),
        encodeFrame(channel, HC_FRAME.DATA, Buffer.from(terminal.screen)),
      ]));
      return;
    }
    if (call.method === "terminal.kill") {
      const id = String(call.params.terminal);
      if (!terminals.delete(id)) { reply(socket, call.id, { error: { code: -1, message: "x", data: { kind: "not_found" } } }); return; }
      for (const viewer of viewers.filter((entry) => entry.terminal === id)) {
        send(viewer.socket, viewer.channel, HC_FRAME.CLOSE, Buffer.alloc(0));
        viewers.splice(viewers.indexOf(viewer), 1);
      }
      reply(socket, call.id, { result: {} });
      return;
    }
    reply(socket, call.id, { error: { code: -32601, message: "x", data: { kind: "method_not_found" } } });
  }

  function connect(): HcSocket & { destroyed: boolean } {
    const socket = new EventEmitter() as FakeSocket;
    const decoder = new HcFrameDecoder();
    let framed = false;
    socket.destroyed = false;
    socket.destroy = () => {
      if (socket.destroyed) return;
      socket.destroyed = true;
      for (const viewer of viewers.filter((entry) => entry.socket === socket)) viewers.splice(viewers.indexOf(viewer), 1);
      queueMicrotask(() => socket.emit("close"));
    };
    socket.write = (data: Buffer | string) => {
      if (socket.destroyed) return false;
      if (!framed) {
        framed = true;
        queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
          version: options.version ?? "0.1.19", generation: 1, framed: true,
          features: options.features ?? ["framed", "attach", "shell"],
          methods: options.methods ?? ["terminal.list", "terminal.run", "terminal.attach", "terminal.kill"],
        } })}\n`)));
        return true;
      }
      for (const frame of decoder.push(Buffer.from(data as Buffer))) {
        if (frame.channel === 0) { handle(socket, JSON.parse(frame.payload.toString("utf8"))); continue; }
        const viewer = viewers.find((entry) => entry.socket === socket && entry.channel === frame.channel);
        if (!viewer) continue;
        if (frame.kind === HC_FRAME.DATA) terminals.get(viewer.terminal)?.input.push(frame.payload.toString("latin1"));
        else if (frame.kind === HC_FRAME.CREDIT) viewer.credits += frame.payload.readUInt32LE(0);
        else if (frame.kind === HC_FRAME.RESIZE) {
          terminals.get(viewer.terminal)?.resizes.push({ cols: frame.payload.readUInt16LE(0), rows: frame.payload.readUInt16LE(2) });
        } else if (frame.kind === HC_FRAME.CLOSE) viewers.splice(viewers.indexOf(viewer), 1);
      }
      return true;
    };
    sockets.push(socket);
    return socket;
  }

  return {
    connect,
    calls,
    sockets,
    viewers,
    terminals,
    add(id: string, terminal: Partial<FakeTerminal> = {}) {
      terminals.set(id, { title: id, status: null, screen: "", input: [], resizes: [], ...terminal });
    },
    /** Output from the program, sent to every viewer of the terminal. */
    output(id: string, text: string) {
      for (const viewer of viewers.filter((entry) => entry.terminal === id)) send(viewer.socket, viewer.channel, HC_FRAME.DATA, Buffer.from(text));
    },
    failList(kind: string | null) { listFailure = kind; },
    /** The core goes away: every connection ends. */
    crash() { for (const socket of sockets) socket.destroy(); },
  };
}
