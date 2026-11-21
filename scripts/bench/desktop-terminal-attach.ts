// Benchmarks the Electron main-process path a local terminal's output takes
// (spec 2701 layer 6): a scripted herdr-core speaking the framed protocol,
// the real herdr-core client and session code, and a MessageChannel standing
// in for the hop to the Terminal window (structured clone, like Electron IPC).
// The window acknowledges each event the way the renderer does, so the core's
// credit window paces the run exactly as in the app.
//
//   pnpm exec tsx scripts/bench/desktop-terminal-attach.ts [--runs 5] [--mib 64]
//
// Prints the median of each measurement. Nothing here touches the network or
// the user's own herdr-core.
import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { connectHc, type HcSocket } from "../../packages/herdr-core-client/src/client";
import { encodeFrame, HC_FRAME, HcFrameDecoder } from "../../packages/herdr-core-client/src/protocol";
import { createHcSessions } from "../../packages/herdr-core-client/src/sessions";
import { createLocalTerminalStreams } from "../../desktop/src/main/local-terminals/streams";

const CORE_WINDOW = 256 * 1024; // herdr-core's initial credit per stream
const CORE_CHUNK = 16 * 1024; // herdr-core's output chunk
const SOCKET_READ = 64 * 1024; // what one socket read typically carries

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A first paint like herdr-core's: 2,000 lines of history, then a screen. */
function firstPaint(): Buffer {
  const history = Array.from({ length: 2_000 }, (_, index) => `\x1b[32m${String(index).padStart(5, "0")}\x1b[0m ${"lorem ipsum dolor sit amet ".repeat(3)}`);
  return Buffer.from(`\x18\x1b[!p\x1b[H\x1b[2J${history.join("\r\n")}\x1b[0m\r\n${"\n".repeat(30)}\x1b[H\x1b[2J$ `);
}

/** A scripted core: answers the handshake and attach, then streams `output` under credit. */
function scriptedCore(output: () => Buffer) {
  const socket = new EventEmitter() as EventEmitter & HcSocket;
  const decoder = new HcFrameDecoder();
  let handshaken = false;
  let credit = CORE_WINDOW;
  let channel = 0;
  let pending: Buffer = Buffer.alloc(0);
  let offset = 0;
  let pump: (() => void) | null = null;

  const emitReads = (bytes: Buffer) => {
    for (let start = 0; start < bytes.length; start += SOCKET_READ) socket.emit("data", bytes.subarray(start, start + SOCKET_READ));
  };
  pump = () => {
    const frames: Buffer[] = [];
    while (offset < pending.length && credit > 0) {
      const size = Math.min(CORE_CHUNK, credit, pending.length - offset);
      frames.push(encodeFrame(channel, HC_FRAME.DATA, pending.subarray(offset, offset + size)));
      offset += size;
      credit -= size;
    }
    if (frames.length > 0) emitReads(Buffer.concat(frames));
  };
  socket.write = (data: Buffer | string) => {
    if (!handshaken) {
      handshaken = true;
      queueMicrotask(() => socket.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {
        version: "0.1.19", generation: 1, framed: true, features: ["framed", "attach"], methods: [],
      } })}\n`)));
      return true;
    }
    for (const frame of decoder.push(data as Buffer)) {
      if (frame.channel === 0 && frame.kind === HC_FRAME.DATA) {
        const call = JSON.parse(frame.payload.toString("utf8")) as { id: number; method: string };
        if (call.method !== "terminal.attach") continue;
        channel = 7;
        pending = output();
        offset = 0;
        credit = CORE_WINDOW;
        // The reply and the first output share one read, as they can on a real socket.
        const reply = encodeFrame(0, HC_FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { channel } })));
        const first = Math.min(CORE_CHUNK, pending.length);
        const head = encodeFrame(channel, HC_FRAME.DATA, pending.subarray(0, first));
        offset = first;
        credit -= first;
        queueMicrotask(() => { emitReads(Buffer.concat([reply, head])); pump?.(); });
      } else if (frame.kind === HC_FRAME.CREDIT) {
        credit += frame.payload.readUInt32LE(0);
        queueMicrotask(() => pump?.());
      }
    }
    return true;
  };
  socket.destroy = () => undefined;
  return { socket, done: () => offset >= pending.length };
}

interface RunResult { firstWriteMs: number; paintMs: number; bytes: number; events: number; totalMs: number }

// "text": output decoded to strings in main and sent as text slices, as the
// Terminal window received it before layer 6 (and as text sinks still do).
// "bytes": the Terminal window's path now, through the real streams module:
// the core's bytes over the attachment's port, acknowledged over it.
type Mode = "text" | "bytes";

async function run(output: () => Buffer, mode: Mode): Promise<RunResult> {
  const core = scriptedCore(output);
  const connection = await connectHc({ open: () => core.socket, expectedVersion: "0.1.19" });
  const total = output().length;
  let received = 0;
  let events = 0;
  let firstAt = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const count = (size: number) => {
    if (firstAt === 0) firstAt = performance.now();
    received += size;
    events += 1;
    if (received >= total) resolveDone();
  };
  const opened: MessagePort[] = [];
  let sessions: ReturnType<typeof createHcSessions>;
  if (mode === "text") {
    // Main → window: one event per decoded slice, acknowledged back.
    const { port1: mainPort, port2: windowPort } = new MessageChannel();
    opened.push(mainPort, windowPort);
    sessions = createHcSessions({ ensure: async () => connection }, {
      output: (attachId, data) => mainPort.postMessage({ attachId, data }),
      closed: () => undefined,
    });
    windowPort.on("message", (event: { attachId: number; data: string }) => {
      windowPort.postMessage({ attachId: event.attachId, count: 1 });
      count(Buffer.byteLength(event.data));
    });
    mainPort.on("message", (ack: { attachId: number; count: number }) => { sessions.acknowledge(ack.attachId, ack.count); });
  } else {
    // The production main-process streams module, with Node ports for Electron's.
    const streams = createLocalTerminalStreams<MessagePort>({
      target: () => ({
        postMessage: (_channel, _message, [windowPort]) => {
          windowPort!.on("message", (data: unknown) => {
            if (!(data instanceof Uint8Array)) return;
            windowPort!.postMessage({ type: "ack", count: 1 });
            count(data.byteLength);
          });
        },
      }),
      createChannel: () => {
        const { port1, port2 } = new MessageChannel();
        opened.push(port1, port2);
        return {
          port1: {
            postMessage: (message: unknown) => port1.postMessage(message),
            on: (_event: "message", listener: (event: { data: unknown }) => void) => port1.on("message", (data: unknown) => listener({ data })),
            start: () => port1.start(),
            close: () => port1.close(),
          },
          port2,
        };
      },
    });
    sessions = createHcSessions({ ensure: async () => connection }, streams.sink);
    streams.bind(sessions);
  }
  const started = performance.now();
  await sessions.attach("t1", { cols: 120, rows: 30 });
  await done;
  const finished = performance.now();
  for (const port of opened) port.close();
  connection.close();
  return { firstWriteMs: firstAt - started, paintMs: finished - started, bytes: received, events, totalMs: finished - started };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function main(): Promise<void> {
  const runs = argument("runs", 5);
  const mib = argument("mib", 64);
  const paint = firstPaint();
  // Typical program output: printable text with colour, as `yes`-style floods produce.
  const flood = Buffer.from(`\x1b[33mwarn\x1b[0m ${"0123456789abcdef".repeat(4)}\r\n`.repeat(Math.ceil((mib * 1024 * 1024) / 80))).subarray(0, mib * 1024 * 1024);
  const report: Record<string, unknown> = { runs };
  for (const mode of ["text", "bytes"] as const) {
    await run(() => paint, mode); // warm-up
    const attach: RunResult[] = [];
    const throughput: RunResult[] = [];
    for (let index = 0; index < runs; index += 1) {
      attach.push(await run(() => paint, mode));
      throughput.push(await run(() => flood, mode));
    }
    const mibPerSecond = throughput.map((result) => result.bytes / (1024 * 1024) / (result.totalMs / 1000));
    report[mode] = {
      attach: {
        paintBytes: paint.length,
        firstWriteMs: Number(median(attach.map((result) => result.firstWriteMs)).toFixed(2)),
        fullPaintMs: Number(median(attach.map((result) => result.paintMs)).toFixed(2)),
        events: median(attach.map((result) => result.events)),
      },
      throughput: { mib, mibPerSecond: Number(median(mibPerSecond).toFixed(1)), events: median(throughput.map((result) => result.events)) },
    };
  }
  console.log(JSON.stringify(report, null, 2));
}

await main();
