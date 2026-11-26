// The byte stream to the owner's herdr-core: `herdr-core connect` spawned as
// the gateway's own user, exactly as Electron reaches a Matrix computer's core
// over SSH (spec 651 J6). herdr-core resolves its own socket; nothing here
// names a path.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { HcSocket } from "@matrix-os/herdr-core-client/client";
import { HerdrTransportError } from "@matrix-os/herdr-core-client/session-host";

const DEFAULT_BIN = "herdr-core";
const KILL_GRACE_MS = 2_000;
// The host keeps one connection; a few more cover a reconnect racing a close.
const MAX_CHILDREN = 4;

type Spawn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;

export function createHerdrCoreTransport(options: {
  /** Default: `MATRIX_HERDR_CORE_BIN`, else `herdr-core` on PATH. */
  bin?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
} = {}) {
  const env = options.env ?? process.env;
  const bin = options.bin ?? (env.MATRIX_HERDR_CORE_BIN?.trim() || DEFAULT_BIN);
  const spawnChild: Spawn = options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  // Bounded by MAX_CHILDREN; entries leave when the child exits.
  const children = new Set<ChildProcessWithoutNullStreams>();
  let closed = false;

  function end(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const force = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    force.unref();
  }

  function open(): Promise<HcSocket> {
    if (closed) return Promise.reject(new HerdrTransportError("unavailable"));
    if (children.size >= MAX_CHILDREN) return Promise.reject(new HerdrTransportError("unavailable"));
    return new Promise<HcSocket>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnChild(bin, ["connect"], { env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error: unknown) {
        console.warn("[herdr] herdr-core connect could not start", error instanceof Error ? error.name : "unknown_error");
        reject(new HerdrTransportError("unavailable"));
        return;
      }
      children.add(child);
      const socket = new EventEmitter() as EventEmitter & HcSocket;
      let started = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        socket.emit("close");
      };
      child.on("spawn", () => {
        started = true;
        resolve(socket);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (!started) {
          children.delete(child);
          const missing = error.code === "ENOENT" || error.code === "EACCES" || error.code === "ENOTDIR";
          reject(new HerdrTransportError(missing ? "not-installed" : "unavailable"));
          return;
        }
        console.warn("[herdr] herdr-core connect failed", error.code ?? error.name);
        if (!done) socket.emit("error", new HerdrTransportError("unavailable"));
      });
      child.on("exit", () => {
        children.delete(child);
        finish();
      });
      // What herdr-core prints about itself stays on this machine; it is read
      // so the pipe never fills, and dropped.
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => { if (!done) socket.emit("data", chunk); });
      child.stdout.on("end", finish);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // EPIPE after the child exited is expected; the exit handler reports it.
        if (error.code !== "EPIPE") console.warn("[herdr] herdr-core connect stdin failed", error.code ?? error.name);
      });
      socket.write = (data: Buffer | string) => (!done && child.stdin.writable ? child.stdin.write(data) : false);
      socket.destroy = () => {
        child.stdin.end();
        end(child);
        finish();
      };
    });
  }

  return {
    open,
    /** How many `herdr-core connect` children are running. */
    children: () => children.size,
    /** Ends every child; the gateway is shutting down. */
    close(): void {
      closed = true;
      for (const child of children) end(child);
    },
  };
}
