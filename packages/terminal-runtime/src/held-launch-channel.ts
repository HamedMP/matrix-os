import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { z } from "zod/v4";

// Preserve the existing managed/Terminal pipe bounds; none imply source proof.
export const HELD_LAUNCH_FRAME_BYTES = 196608;
export interface HeldLaunchChannel<Host, Child> {
  readonly generation: string;
  send(frame: Host): boolean;
  subscribe(receive: (frame: Child) => void, close: () => void): () => void;
  close(): void;
}
export type HeldLaunchSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
export type HeldLaunchOptions = { args: string[]; digest: string; env: NodeJS.ProcessEnv; spawn?: HeldLaunchSpawn };
type ParseFrame = <Frame>(schema: z.ZodType<Frame>, value: unknown) => Frame | undefined;
export interface HeldLaunchProtocol<Host, Child extends { type: string }> {
  hostSchema: z.ZodType<Host>;
  childSchema: z.ZodType<Child>;
  handshakeSchema: z.ZodType<{ generation: string; digest: string; reply: Host }>;
  readyTypes: ReadonlyArray<Child["type"]>;
  endTypes: ReadonlyArray<Child["type"]>;
  parseFrame?: ParseFrame;
}

function parseHeldFrame<Frame>(schema: z.ZodType<Frame>, value: unknown): Frame | undefined {
  let bytes;
  try { bytes = JSON.stringify(value); } catch (error) { if (!(error instanceof TypeError)) console.warn("[managed-launch] Invalid frame", error instanceof Error ? error.name : "UnknownError"); return undefined; }
  if (!bytes || Buffer.byteLength(bytes) > HELD_LAUNCH_FRAME_BYTES) return undefined;
  return schema.safeParse(value).data;
}

/** Owns only this spawned systemd client's anonymous pipe, never its service,
 * keeper/daemon identity or source authority. Closing does not stop the unit. */
export async function openHeldLaunchChannel<Host, Child extends { type: string }>(options: HeldLaunchOptions,
  protocol: HeldLaunchProtocol<Host, Child>): Promise<HeldLaunchChannel<Host, Child>> {
  const parse = protocol.parseFrame ?? parseHeldFrame;
  const child = (options.spawn ?? spawn)("/usr/bin/systemd-run", options.args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false, bytes = "", buffered = 0, generation: string | undefined;
  const decoder = new StringDecoder("utf8");
  const listeners = new Set<{ receive(frame: Child): void; close(): void }>(); // max4; detach/close eviction.
  let resolveReady!: (channel: HeldLaunchChannel<Host, Child>) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<HeldLaunchChannel<Host, Child>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const channel: HeldLaunchChannel<Host, Child> = {
    get generation() { if (!generation) throw new Error("Private launch unavailable"); return generation; },
    send(raw) {
      const frame = parse(protocol.hostSchema, raw);
      if (closed || !frame || child.stdin.writableLength > HELD_LAUNCH_FRAME_BYTES * 2) { close(); return false; }
      child.stdin.write(JSON.stringify(frame) + "\n", error => { if (error) close(); }); return true;
    },
    subscribe(receive, onClose) {
      if (closed || listeners.size >= 4) throw new Error("Private launch unavailable");
      const entry = { receive, close: onClose }; listeners.add(entry); return () => listeners.delete(entry);
    },
    close,
  };
  function close() {
    if (closed) return; closed = true; clearTimeout(timer);
    child.stdin.end(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    for (const entry of listeners) { try { entry.close(); } catch (error) { console.warn("[managed-launch] Close unavailable", error instanceof Error ? error.name : "UnknownError"); } }
    listeners.clear(); rejectReady(new Error("Private launch unavailable"));
  }
  const timer = setTimeout(close, 10_000); timer.unref();
  child.stdin.on("error", close); child.stdout.on("error", close); child.stderr.on("error", close);
  child.stdout.once("end", close); child.stdout.once("close", close);
  child.on("error", close); child.once("exit", close);
  child.stderr.on("data", chunk => { buffered += chunk.length; if (buffered > 16384) close(); });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += decoder.write(chunk);
    if (Buffer.byteLength(bytes) > HELD_LAUNCH_FRAME_BYTES) { close(); return; }
    let newline;
    while ((newline = bytes.indexOf("\n")) >= 0 && !closed) {
      const line = bytes.slice(0, newline); bytes = bytes.slice(newline + 1);
      let frame: Child | undefined;
      try { frame = parse(protocol.childSchema, JSON.parse(line)); } catch (error) { if (!(error instanceof SyntaxError)) console.warn("[managed-launch] Frame unavailable", error instanceof Error ? error.name : "UnknownError"); }
      if (!frame) { close(); return; }
      if (!generation) {
        const handshake = parse(protocol.handshakeSchema, frame);
        if (!handshake || !handshake.generation || handshake.digest !== options.digest) { close(); return; }
        generation = handshake.generation;
        if (!channel.send(handshake.reply)) return;
        clearTimeout(timer); resolveReady(channel);
      } else {
        if (protocol.endTypes.includes(frame.type) || protocol.readyTypes.includes(frame.type)) { close(); return; }
        for (const entry of listeners) { try { entry.receive(frame); } catch (error) { console.warn("[managed-launch] Receiver unavailable", error instanceof Error ? error.name : "UnknownError"); close(); return; } }
      }
    }
  });
  return ready;
}
