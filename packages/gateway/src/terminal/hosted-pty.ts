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
  /** Immutable host supplies its verified generation-local module; ordinary callers retain the existing resolver. */
  pty?: Pick<typeof import("node-pty"), "spawn">;
}) {
  const directory = resolve(options.directory), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Terminal I/O unavailable");
  const size = Frame.options[1].parse({ type: "resize", cols: options.cols, rows: options.rows });
  const path = join(directory, "io.sock");
  if (Buffer.byteLength(path) >= 104) throw new Error("Terminal I/O unavailable");
  const peers = new Set<Socket>(); // <=8; output cap, heartbeat TTL, disconnect and shutdown eviction.
  const proof = new AbortController();
  const forcedTeardown = new AbortController();
  let running = true, closed = false, firstAttached = false, stopping: Promise<void> | undefined, closing: Promise<void> | undefined;
  // One initial handoff only: capped bytes, native backpressure at half capacity,
  // and a post-exit TTL. This is neither a screen snapshot nor a replay log.
  let initial = Buffer.alloc(256 * 1024), initialSize = 0, initialPaused = false, initialIncomplete = false, initialBackpressureUsed = false;
  let resumeTimer: NodeJS.Timeout | undefined;
  let handoffFinished = false, handoffTimer: NodeJS.Timeout | undefined, delivered!: () => void;
  const initialOutputDelivered = new Promise<void>(resolve => { delivered = resolve; });
  function finishHandoff() {
    if (handoffFinished) return; handoffFinished = true; clearTimeout(handoffTimer); clearTimeout(resumeTimer);
    initial = Buffer.alloc(0); initialSize = 0; delivered();
  }
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
          if (!running) { socket.end(); return; }
          if (frame.type === "input") child.write(frame.data);
          if (frame.type === "resize") child.resize(frame.cols, frame.rows);
        } catch (error) {
          console.warn("[terminal-host] Viewer unavailable", error instanceof Error ? error.name : "UnknownError"); socket.destroy();
        }
      }
    });
    if (!firstAttached) {
      firstAttached = true;
      const output = Buffer.concat([initial.subarray(0, initialSize), initialIncomplete ? Buffer.from("\r\n[Initial terminal output may be incomplete.]\r\n") : Buffer.alloc(0)]);
      // Release retention after the bounded first write settles; a broken pane
      // cannot hold the ended host forever. Subsequent peers never replay bytes.
      socket.once("close", finishHandoff);
      socket.write(output, error => { finishHandoff(); if (error) socket.destroy(); });
      if (running && initialPaused) { initialPaused = false; child.resume(); }
    }
    if (!running) socket.end();
  });
  await new Promise<void>((resolveReady, reject) => { server.once("error", reject); server.listen(path, resolveReady); });
  server.on("error", error => { console.warn("[terminal-host] I/O listener unavailable", error.name); });
  let child: IPty;
  try {
    const pty = options.pty ?? createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
    child = pty.spawn(options.launch.command, options.launch.args, { name: "xterm-256color", cwd: options.launch.cwd,
      env: options.launch.env, cols: size.cols, rows: size.rows });
  } catch (error) { server.close(); await unlink(path); throw error; }
  const data = child.onData(bytes => {
    if (!firstAttached && !handoffFinished) {
      const chunk = Buffer.from(bytes), available = initial.length - initialSize, retained = Math.min(available, chunk.length);
      chunk.copy(initial, initialSize, 0, retained); initialSize += retained;
      if (retained !== chunk.length) initialIncomplete = true;
      if (initialSize >= 128 * 1024 && !initialBackpressureUsed) {
        initialBackpressureUsed = true; initialPaused = true; child.pause();
        // node-pty's public exit notification can depend on readable drainage.
        // Never let a missing pane indefinitely hide an exited native root.
        // After this short handoff grace, drain with capped prefix+explicit loss.
        resumeTimer = setTimeout(() => { if (running && initialPaused) { initialPaused = false; child.resume(); } }, 100); resumeTimer.unref();
      }
      return;
    }
    for (const socket of peers) {
      if (socket.destroyed || socket.writableLength > 256 * 1024) { socket.destroy(); continue; }
      socket.write(bytes, error => { if (error) socket.destroy(); });
    }
  });
  const ended = child.onExit(() => {
    running = false; proof.abort(); clearTimeout(resumeTimer);
    // node-pty can force-close a paused stream after native exit. Do not claim
    // its unread tail was delivered, or hold source authority for output drain.
    if (initialBackpressureUsed && !firstAttached) initialIncomplete = true;
    for (const socket of peers) socket.end(); exited();
    if (!firstAttached && !handoffFinished) { handoffTimer = setTimeout(finishHandoff, 30000); handoffTimer.unref(); }
  });
  function drainViewer(socket: Socket): Promise<void> {
    if (socket.destroyed || socket.writableFinished || forcedTeardown.signal.aborted) return Promise.resolve();
    return new Promise(resolveDrain => {
      let done = false;
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer);
        socket.off("finish", finish); socket.off("close", finish); socket.off("error", finish);
        forcedTeardown.signal.removeEventListener("abort", finish); resolveDrain();
      };
      // <=8 current viewers; one fixed deadline each. Native exit/proof fencing
      // already happened and must never wait for a pane's output backpressure.
      const timer = setTimeout(() => { console.warn("[terminal-host] Final viewer output drain expired"); finish(); }, 5000); timer.unref();
      socket.once("finish", finish); socket.once("close", finish); socket.once("error", finish);
      forcedTeardown.signal.addEventListener("abort", finish, { once: true }); socket.end();
    });
  }
  return {
    pid: child.pid, path, signal: proof.signal, exited: exit, initialOutputDelivered,
    get running() { return running; },
    closeProof() { proof.abort(); },
    stop(): Promise<void> {
      forcedTeardown.abort();
      if (stopping) return stopping;
      proof.abort(); finishHandoff();
      if (initialPaused) { initialPaused = false; child.resume(); }
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
    close(options: { drain?: boolean } = {}): Promise<void> {
      if (!options.drain) forcedTeardown.abort();
      if (closing) return closing;
      closed = true; proof.abort(); finishHandoff();
      if (running && initialPaused) { initialPaused = false; child.resume(); }
      closing = (async () => {
        if (options.drain) await Promise.all([...peers].map(drainViewer));
        for (const socket of peers) socket.destroy(); peers.clear();
        await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
        // Detaching I/O/proof never signals the child. Event subscriptions remain until actual exit.
        if (running) void exit.then(() => { data.dispose(); ended.dispose(); });
        else { data.dispose(); ended.dispose(); }
        try { await unlink(path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      })();
      return closing;
    },
  };
}
