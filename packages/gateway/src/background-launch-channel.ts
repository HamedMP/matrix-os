import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { ManagedHostFrameSchema, ManagedShimFrameSchema, parseManagedFrame, MANAGED_FRAME_BYTES, type ManagedHostFrame, type ManagedShimFrame } from "./coding-agents/managed-launch-protocol.mjs";
import type { AgentLaunchSpec } from "./agent-launcher.js";
export interface ManagedLaunchChannel {
  readonly generation: string;
  send(frame: ManagedHostFrame): boolean;
  subscribe(receive: (frame: ManagedShimFrame) => void, close: () => void): () => void;
  close(): void;
}
export interface BackgroundPrivateControl { onReady(channel: ManagedLaunchChannel): void }
export type PrivateLaunchSpawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
const ownedShim = fileURLToPath(new URL("./coding-agents/codex-app-server-runner.mjs", import.meta.url));
/** Binding is the inherited anonymous pipe held by this exact spawned systemd client, not a bg ID or socket path. */
export function validPrivateLaunch(launch: AgentLaunchSpec): boolean {
  return launch.command === process.execPath && launch.args[0] === ownedShim;
}
export async function openBackgroundLaunchChannel(options: { args: string[]; digest: string; env: NodeJS.ProcessEnv; spawn?: PrivateLaunchSpawn }): Promise<ManagedLaunchChannel> {
  const child = (options.spawn ?? spawn)("/usr/bin/systemd-run", options.args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false, bytes = "", buffered = 0, generation: string | undefined;
  const decoder = new StringDecoder("utf8");
  const listeners = new Set<{ receive(frame: ManagedShimFrame): void; close(): void }>(); // max4; removed on detach/close.
  let resolveReady!: (channel: ManagedLaunchChannel) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<ManagedLaunchChannel>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const channel: ManagedLaunchChannel = {
    get generation() { if (!generation) throw new Error("Private launch unavailable"); return generation; },
    send(raw) {
      const frame = parseManagedFrame(ManagedHostFrameSchema, raw);
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
      let frame: ManagedShimFrame | undefined;
      try { frame = parseManagedFrame(ManagedShimFrameSchema, JSON.parse(line)); } catch (error) { if (!(error instanceof SyntaxError)) console.warn("[managed-launch] Frame unavailable", error instanceof Error ? error.name : "UnknownError"); }
      if (!frame) { close(); return; }
      if (!generation) {
        if (frame.type !== "wrapper.ready" || frame.digest !== options.digest) { close(); return; }
        generation = frame.wrapper + ":" + frame.shim;
        channel.send({ ...frame, type: "host.ready" });
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
