import type { z } from "zod/v4";
import { TerminalHostFrameSchema, TerminalShimFrameSchema, type TerminalHostFrame, type TerminalShimFrame } from "./coding-agents/terminal-launch-protocol.mjs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { ManagedHostFrameSchema, ManagedShimFrameSchema, parseManagedFrame, MANAGED_FRAME_BYTES, type ManagedHostFrame, type ManagedShimFrame } from "./coding-agents/managed-launch-protocol.mjs";
import type { AgentLaunchSpec } from "./agent-launcher.js";
export interface HeldLaunchChannel<Host, Child> {
  readonly generation: string;
  send(frame: Host): boolean;
  subscribe(receive: (frame: Child) => void, close: () => void): () => void;
  close(): void;
}
export type ManagedLaunchChannel = HeldLaunchChannel<ManagedHostFrame, ManagedShimFrame>;
export type TerminalLaunchChannel = HeldLaunchChannel<TerminalHostFrame, TerminalShimFrame>;
export interface BackgroundPrivateControl { onReady(channel: ManagedLaunchChannel): void }
export type PrivateLaunchSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
const ownedShim = fileURLToPath(new URL("./coding-agents/codex-app-server-runner.mjs", import.meta.url));
/** Binding is the inherited anonymous pipe held by this exact spawned systemd client, not a bg ID or socket path. */
export function validPrivateLaunch(launch: AgentLaunchSpec): boolean {
  return launch.command === process.execPath && launch.args[0] === ownedShim;
}
type LaunchChannelOptions = { args: string[]; digest: string; env: NodeJS.ProcessEnv; spawn?: PrivateLaunchSpawn };
export function openBackgroundLaunchChannel(options: LaunchChannelOptions): Promise<ManagedLaunchChannel> {
  return openHeldLaunchChannel(options, ManagedHostFrameSchema, ManagedShimFrameSchema);
}
export function openTerminalLaunchChannel(options: LaunchChannelOptions): Promise<TerminalLaunchChannel> {
  return openHeldLaunchChannel(options, TerminalHostFrameSchema, TerminalShimFrameSchema);
}
async function openHeldLaunchChannel<Host, Child extends { type: string }>(options: LaunchChannelOptions,
  hostSchema: z.ZodType<Host>, childSchema: z.ZodType<Child>): Promise<HeldLaunchChannel<Host, Child>> {
  const child = (options.spawn ?? spawn)("/usr/bin/systemd-run", options.args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false, bytes = "", buffered = 0, generation: string | undefined;
  const decoder = new StringDecoder("utf8");
  const listeners = new Set<{ receive(frame: Child): void; close(): void }>(); // max4; removed on detach/close.
  let resolveReady!: (channel: HeldLaunchChannel<Host, Child>) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<HeldLaunchChannel<Host, Child>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const channel: HeldLaunchChannel<Host, Child> = {
    get generation() { if (!generation) throw new Error("Private launch unavailable"); return generation; },
    send(raw) {
      const frame = parseManagedFrame(hostSchema, raw);
      if (closed || !frame || child.stdin.writableLength > MANAGED_FRAME_BYTES * 2) { close(); return false; }
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
    // Never stop/relaunch the service to recover source proof. EOF only revokes private authority.
    child.stdin.end(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
    for (const entry of listeners) { try { entry.close(); } catch (error) { console.warn("[managed-launch] Close unavailable", error instanceof Error ? error.name : "UnknownError"); } }
    listeners.clear(); rejectReady(new Error("Private launch unavailable"));
  }
  const timer = setTimeout(close, 10_000); timer.unref();
  child.stdin.on("error", close); child.stdout.on("error", close); child.stderr.on("error", close);
  child.stdout.once("end", close); child.stdout.once("close", close);
  child.on("error", close); child.once("exit", close);
  child.stderr.on("data", chunk => { buffered += chunk.length; if (buffered > 16384) close(); }); // never log transport/private bytes.
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += decoder.write(chunk);
    if (Buffer.byteLength(bytes) > MANAGED_FRAME_BYTES) { close(); return; }
    let newline;
    while ((newline = bytes.indexOf("\n")) >= 0 && !closed) {
      const line = bytes.slice(0, newline); bytes = bytes.slice(newline + 1);
      let frame: Child | undefined;
      try { frame = parseManagedFrame(childSchema, JSON.parse(line)); } catch (error) { if (!(error instanceof SyntaxError)) console.warn("[managed-launch] Frame unavailable", error instanceof Error ? error.name : "UnknownError"); }
      if (!frame) { close(); return; }
      if (!generation) {
        const handshake = parseManagedFrame(ManagedShimFrameSchema, frame);
        if (handshake?.type !== "wrapper.ready" || handshake.digest !== options.digest) { close(); return; }
        generation = handshake.wrapper + ":" + handshake.shim;
        const reply = hostSchema.parse({ ...handshake, type: "host.ready" });
        if (!channel.send(reply)) return;
        clearTimeout(timer); resolveReady(channel);
      } else {
        if (frame.type === "wrapper.end") { close(); return; }
        if (frame.type === "wrapper.ready" || frame.type === "shim.ready") { close(); return; }
        for (const entry of listeners) { try { entry.receive(frame); } catch (error) { console.warn("[managed-launch] Receiver unavailable", error instanceof Error ? error.name : "UnknownError"); close(); return; } }
      }
    }
  });
  return ready;
}
