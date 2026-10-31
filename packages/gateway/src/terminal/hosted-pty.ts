import { createServer, type Socket } from "node:net";
import { lstat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import type { AgentLaunchSpec } from "../agent-launcher.js";
import type { IPty } from "node-pty";
const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().min(1).max(16384) }).strict(),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(1).max(500), rows: z.number().int().min(1).max(200) }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);
/** Owns the actual native PTY. A viewer/proof controller owns NO part of its lifetime.
 * Zellij remains the screen/history renderer. This transport does not invent a screen
 * snapshot from a raw-byte tail; a surviving Zellij pane keeps its existing screen. */
export async function createHostedTerminalPty(options: {
  directory: string; launch: AgentLaunchSpec; cols: number; rows: number;
}) {
  const directory = resolve(options.directory), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Terminal I/O unavailable");
  const size = Frame.options[1].parse({ type: "resize", cols: options.cols, rows: options.rows });
  const path = join(directory, "io.sock");
  if (Buffer.byteLength(path) >= 104) throw new Error("Terminal I/O unavailable");
  const peers = new Set<Socket>(); // <=8; output cap, heartbeat TTL, disconnect and shutdown eviction.
  const proof = new AbortController();
  let running = true, closed = false, stopping: Promise<void> | undefined;
  let exited!: () => void;
  const exit = new Promise<void>(resolve => { exited = resolve; });
  const server = createServer(socket => {
    if (closed || peers.size >= 8) { socket.destroy(); return; }
    peers.add(socket); socket.setEncoding("utf8"); socket.setTimeout(60000, () => socket.destroy());
    let input = "";
    socket.on("error", () => socket.destroy()); socket.once("close", () => peers.delete(socket));
    socket.on("data", bytes => {
      input += bytes;
      if (Buffer.byteLength(input) > 32768) { socket.destroy(); return; }
      let newline;
      while ((newline = input.indexOf("\n")) !== -1 && !socket.destroyed) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        try {
          const frame = Frame.parse(JSON.parse(line));
          if (!running) { socket.destroy(); return; }
          if (frame.type === "input") child.write(frame.data);
          if (frame.type === "resize") child.resize(frame.cols, frame.rows);
        } catch (error) {
          console.warn("[terminal-host] Viewer unavailable", error instanceof Error ? error.name : "UnknownError"); socket.destroy();
        }
      }
    });
  });
  await new Promise<void>((resolveReady, reject) => { server.once("error", reject); server.listen(path, resolveReady); });
  server.on("error", error => { console.warn("[terminal-host] I/O listener unavailable", error.name); });
  let child: IPty;
  try {
    const pty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
    child = pty.spawn(options.launch.command, options.launch.args, { name: "xterm-256color", cwd: options.launch.cwd,
      env: options.launch.env, cols: size.cols, rows: size.rows });
  } catch (error) { server.close(); await unlink(path); throw error; }
  const data = child.onData(bytes => {
    for (const socket of peers) {
      if (socket.destroyed || socket.writableLength > 256 * 1024) { socket.destroy(); continue; }
      socket.write(bytes, error => { if (error) socket.destroy(); });
    }
  });
  const ended = child.onExit(() => {
    running = false; proof.abort(); for (const socket of peers) socket.end(); exited();
  });
  return {
    pid: child.pid, path, signal: proof.signal,
    get running() { return running; },
    closeProof() { proof.abort(); },
    stop(): Promise<void> {
      if (stopping) return stopping;
      proof.abort();
      stopping = (async () => {
        if (!running) return;
        child.kill("SIGTERM");
        let force: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
        try {
          force = setTimeout(() => { if (running) child.kill("SIGKILL"); }, 1000);
          await Promise.race([exit, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Terminal stop unconfirmed")), 5000); })]);
        } finally { clearTimeout(force); clearTimeout(deadline); }
      })();
      return stopping;
    },
    async close() {
      if (closed) return; closed = true; proof.abort();
      for (const socket of peers) socket.destroy(); peers.clear();
      await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
      // Detaching I/O/proof never signals the child. Event subscriptions remain until actual exit.
      if (running) void exit.then(() => { data.dispose(); ended.dispose(); });
      else { data.dispose(); ended.dispose(); }
      try { await unlink(path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    },
  };
}
