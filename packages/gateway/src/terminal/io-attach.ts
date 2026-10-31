import { connect } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";
export interface TerminalIoReference { path: string }
export function terminalIoLocation(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || Buffer.byteLength(value) >= 104
    || !/\/matrix-terminal-[a-f0-9]{32}\/io\.sock$/.test(value) || /[\u0000-\u0020?#]/.test(value)) throw new Error("Terminal I/O unavailable");
  return value;
}
/** Fixed I/O-only client for the existing Zellij pane. Location is public and conveys
 * neither source authority nor workload stop. Real stdout dimensions drive the inner PTY. */
export async function attachTerminalIo(options: {
  path: string; input: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(raw: boolean): unknown };
  output: Writable & { columns?: number; rows?: number }; resizeEvents: EventEmitter; signal: AbortSignal;
}) {
  const path = terminalIoLocation(options.path), [directory, info] = await Promise.all([lstat(dirname(path)), lstat(path)]);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || directory.mode & 0o077
    || !info.isSocket() || info.isSymbolicLink() || info.uid !== directory.uid || options.signal.aborted) throw new Error("Terminal I/O unavailable");
  const socket = connect(path), { input, output } = options;
  let ended = false, raw = false, heartbeat: NodeJS.Timeout | undefined;
  const wasRaw = input.isRaw === true, decoder = new StringDecoder("utf8");
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  function close() {
    if (ended) return; ended = true; clearInterval(heartbeat); socket.destroy();
    input.off("data", data); input.off("end", close); input.off("error", close); input.pause();
    output.off("drain", drain); output.off("error", close); output.off("resize", resize);
    options.resizeEvents.off("SIGWINCH", resize); options.signal.removeEventListener("abort", close);
    if (raw) { try { input.setRawMode?.(wasRaw); } catch (error) { console.warn("[terminal-attach] TTY restore unavailable", error instanceof Error ? error.name : "UnknownError"); } }
    resolveClosed();
  }
  function send(frame: unknown) {
    if (ended || socket.writableLength > 256 * 1024) { close(); return; }
    socket.write(JSON.stringify(frame) + "\n", error => { if (error) close(); });
  }
  function resize() {
    const cols = output.columns, rows = output.rows;
    if (Number.isInteger(cols) && cols! > 0 && Number.isInteger(rows) && rows! > 0) send({ type: "resize", cols: Math.min(cols!, 500), rows: Math.min(rows!, 200) });
  }
  function data(bytes: Buffer | string) {
    const text = typeof bytes === "string" ? bytes : decoder.write(bytes);
    for (let at = 0; at < text.length && !ended;) {
      let end = Math.min(text.length, at + 4096);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      send({ type: "input", data: text.slice(at, end) }); at = end;
    }
  }
  function drain() { if (!ended) socket.resume(); }
  socket.on("error", close); socket.once("end", close); socket.once("close", close);
  options.signal.addEventListener("abort", close, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new Error("Terminal I/O unavailable")); }, 5000);
      const failed = () => { clearTimeout(timer); reject(new Error("Terminal I/O unavailable")); };
      socket.once("close", failed); socket.once("connect", () => { clearTimeout(timer); socket.off("close", failed); resolve(); });
    });
    if (ended || options.signal.aborted) throw new Error("Terminal I/O unavailable");
    input.on("data", data); input.once("end", close); input.on("error", close); output.on("drain", drain); output.on("error", close);
    socket.on("data", bytes => { if (output.writableLength > 256 * 1024) { close(); return; } if (!output.write(bytes)) socket.pause(); });
    options.resizeEvents.on("SIGWINCH", resize); output.on("resize", resize);
    if (input.isTTY && input.setRawMode) { input.setRawMode(true); raw = true; }
    input.resume(); resize(); heartbeat = setInterval(() => send({ type: "ping" }), 20000); heartbeat.unref();
    return { close, closed };
  } catch (error) { close(); throw error; }
}
