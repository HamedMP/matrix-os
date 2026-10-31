import { TerminalHostFrameSchema, TerminalShimFrameSchema } from "./terminal-launch-protocol.mjs";
import { randomUUID } from "node:crypto";
import { close as closeDescriptor } from "node:fs";
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { ManagedHostFrameSchema, ManagedShimFrameSchema, parseManagedFrame, MANAGED_FRAME_BYTES } from "./managed-launch-protocol.mjs";
/** Only called for a digest-bound exact owned shim. Anonymous host pipes and child IPC never reach native Codex. */
export function attachManagedLaunchWrapper(child, digest, transport, protocol = "codex") {
  if (!["codex", "terminal"].includes(protocol)) throw new Error("Private protocol unavailable");
  const hostSchema = protocol === "terminal" ? TerminalHostFrameSchema : ManagedHostFrameSchema;
  const shimSchema = protocol === "terminal" ? TerminalShimFrameSchema : ManagedShimFrameSchema;
  // Avoid process.stdout's protected teardown. Close this owned stream AND inherited
  // FD1 (Node may duplicate low stdio FDs); neither belongs to native stdio/logging.
  const input = transport?.input ?? process.stdin;
  const output = transport?.output ?? new Socket({ fd: 1, readable: false, writable: true });
  const wrapper = randomUUID(), decoder = new StringDecoder("utf8");
  let shim, ready = false, closed = false, bytes = "", pending = 0, flushTimer, inheritedClosed = false;
  const timer = setTimeout(close, 10_000); timer.unref();
  function destroyOutput() {
    clearTimeout(flushTimer); output.destroy();
    if (!transport?.output && !inheritedClosed) {
      inheritedClosed = true;
      closeDescriptor(1, error => { if (error && error.code !== "EBADF") console.warn("[managed-launch] Output descriptor close unavailable", error.name); });
    }
  }
  function disconnectShim() {
    const detach = () => { try { if (child.connected) child.disconnect?.(); } catch (error) { console.warn("[managed-launch] Shim detach unavailable", error instanceof Error ? error.name : "UnknownError"); } };
    try { if (child.connected) child.send({ type: "host.disconnect" }, error => { if (error) detach(); }); }
    catch (error) { console.warn("[managed-launch] Shim notification unavailable", error instanceof Error ? error.name : "UnknownError"); detach(); }
  }
  function close() {
    if (closed) return;
    closed = true; clearTimeout(timer);
    input.off("data", data); input.pause();
    if (ready && shim && output.writable && !output.destroyed && output.writableLength <= MANAGED_FRAME_BYTES * 2) {
      // One bounded terminal frame, never recursive send(); a stalled flush cannot hold proof open.
      flushTimer = setTimeout(destroyOutput, 250); flushTimer.unref();
      output.end(JSON.stringify({ type: "wrapper.end", wrapper, shim }) + "\n", destroyOutput);
    } else destroyOutput();
    disconnectShim();
    // Keep native stdin, logs, session, profile and the service alive after Gateway loss.
  }
  function send(frame) {
    if (closed || output.writableLength > MANAGED_FRAME_BYTES * 2) { close(); return; }
    output.write(JSON.stringify(frame) + "\n", error => { if (error) close(); });
  }
  function data(chunk) {
    bytes += decoder.write(chunk);
    if (Buffer.byteLength(bytes) > MANAGED_FRAME_BYTES) { close(); return; }
    let newline;
    while ((newline = bytes.indexOf("\n")) >= 0 && !closed) {
      const line = bytes.slice(0, newline); bytes = bytes.slice(newline + 1);
      let frame;
      try { frame = parseManagedFrame(hostSchema, JSON.parse(line)); }
      catch (error) { if (!(error instanceof SyntaxError)) console.warn("[managed-launch] Invalid frame", error instanceof Error ? error.name : "UnknownError"); }
      if (!frame) { close(); return; }
      if (!ready) {
        if (frame.type !== "host.ready" || frame.wrapper !== wrapper || frame.shim !== shim || frame.digest !== digest) { close(); return; }
        ready = true; clearTimeout(timer);
      } else if (frame.type === "host.ready") { close(); return; }
      if (++pending > 16 || !child.connected) { close(); return; }
      child.send(frame, error => { pending--; if (error) close(); });
    }
  }
  child.on("message", (raw, handle) => {
    const frame = parseManagedFrame(shimSchema, raw);
    if (closed) return;
    if (handle || !frame) { close(); return; }
    if (!shim) {
      if (frame.type !== "shim.ready") { close(); return; }
      shim = frame.shim; send({ type: "wrapper.ready", wrapper, shim, digest }); return;
    }
    if (!ready || frame.type === "shim.ready" || frame.type === "wrapper.ready") { close(); return; }
    send(frame);
  });
  output.on("error", () => { close(); destroyOutput(); }); output.once("close", () => { clearTimeout(flushTimer); close(); }); input.on("error", close);
  input.on("data", data); input.once("end", close);
  child.once("exit", close); child.once("disconnect", close);
  return { close };
}
