import { createRequire } from "node:module";
import { lstat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RoutineCliOperationSchema, RoutineCliEnvelopeSchema, routineCliResultMatchesOperation, type RoutineCliOperation, type RoutineCliEnvelope } from "@matrix-os/contracts/routine-cli";
import { createWriterFrame, type KernelWriter } from "./writer-frame.js";
import { verifyTerminalDescendant, readLinuxProcess, type LinuxProcessIdentity } from "./process-identity.js";
export interface TerminalWriterNative {
  listen(path: string): object;
  accept(listener: object): { handle: object; creator: KernelWriter } | null;
  receive(client: object): { data: Buffer; writer: KernelWriter } | null | false;
  send(client: object, bytes: Buffer): number;
  close(handle: object): void;
}
export function loadTerminalWriterNative(): TerminalWriterNative {
  if (process.platform !== "linux") throw new Error("Terminal proof unavailable");
  return createRequire(import.meta.url)("./terminal-writer.node") as TerminalWriterNative;
}
/** Native owns accept/close/recvmsg FDs. JS never accesses _handle.fd or adopts a
 * descriptor twice. A connection location is not authority. Keep recvmsg active
 * throughout owner waits: EOF/extra bytes synchronously fence this invocation. */
export async function createTerminalWriterBroker(options: {
  directory: string; root: LinuxProcessIdentity; signal: AbortSignal;
  execute(operation: RoutineCliOperation, writer: LinuxProcessIdentity, signal: AbortSignal): Promise<RoutineCliEnvelope>;
  native?: TerminalWriterNative; readProcess?: typeof readLinuxProcess;
}) {
  if (typeof options.execute !== "function" || options.signal.aborted) throw new Error("Terminal proof unavailable");
  const directory = resolve(options.directory), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("Terminal proof unavailable");
  const native = options.native ?? loadTerminalWriterNative(), path = join(directory, "routine.sock"), listener = native.listen(path);
  const root = Object.freeze({ ...options.root });
  type Client = { handle: object; frame: ReturnType<typeof createWriterFrame>; controller: AbortController; deadline: number;
    dispatched: boolean; retired: boolean; pending: boolean; output?: Buffer; offset: number };
  const clients = new Set<Client>(); // <=16, including pending cancellation drains; no eviction permits hidden unbounded work.
  let closed = false;
  function retire(client: Client) {
    if (client.retired) return;
    client.retired = true; client.controller.abort(); native.close(client.handle);
    if (!client.pending) clients.delete(client);
  }
  async function dispatch(client: Client, bytes: string, writer: KernelWriter) {
    client.pending = true;
    try {
      const operation = RoutineCliOperationSchema.parse(JSON.parse(bytes));
      const actual = await verifyTerminalDescendant(root, writer, options.readProcess);
      if (!actual || client.controller.signal.aborted || options.signal.aborted) { retire(client); return; }
      const result = RoutineCliEnvelopeSchema.parse(await options.execute(operation, actual, client.controller.signal));
      if (client.retired || client.controller.signal.aborted || options.signal.aborted) return;
      if ("ok" in result && !routineCliResultMatchesOperation(operation, result.data)) throw new Error("Terminal result mismatch");
      const output = Buffer.from(JSON.stringify(result) + "\n");
      if (output.length > 131073) throw new Error("Terminal result unavailable");
      client.output = output; client.deadline = Date.now() + 1000;
    } catch (error) {
      console.warn("[terminal-broker] Request unavailable", error instanceof Error ? error.name : "UnknownError"); retire(client);
    } finally { client.pending = false; if (client.retired) clients.delete(client); }
  }
  function poll() {
    if (closed) return;
    try {
      for (let count = 0; count < 8 && clients.size < 16; count++) {
        const accepted = native.accept(listener); if (!accepted) break;
        clients.add({ ...accepted, frame: createWriterFrame(accepted.creator), controller: new AbortController(), deadline: Date.now() + 5000,
          dispatched: false, retired: false, pending: false, offset: 0 });
      }
      for (const client of clients) {
        if (client.retired) continue;
        if (Date.now() >= client.deadline) { retire(client); continue; }
        try {
          // Read even after dispatch, and before sending a result. No request-side half-close protocol.
          for (let count = 0; count < 8; count++) {
            const chunk = native.receive(client.handle);
            if (chunk === null) break;
            if (chunk === false || client.dispatched) { retire(client); break; }
            const frame = client.frame.push(chunk);
            if (frame) {
              client.dispatched = true; client.deadline = Date.now() + 120000;
              void dispatch(client, frame.bytes, frame.writer);
            }
          }
          if (client.output && !client.retired) {
            const sent = native.send(client.handle, client.output.subarray(client.offset));
            if (!Number.isInteger(sent) || sent < 0 || sent > client.output.length - client.offset) throw new Error("Terminal output unavailable");
            client.offset += sent;
            if (client.offset === client.output.length) retire(client);
          }
        } catch (error) {
          console.warn("[terminal-broker] Peer unavailable", error instanceof Error ? error.name : "UnknownError"); retire(client);
        }
      }
    } catch (error) {
      console.warn("[terminal-broker] Native proof unavailable", error instanceof Error ? error.name : "UnknownError"); fence();
    }
  }
  const interval = setInterval(poll, 5); interval.unref();
  function fence() {
    if (closed) return; closed = true; clearInterval(interval); options.signal.removeEventListener("abort", fence);
    native.close(listener); for (const client of clients) retire(client);
  }
  options.signal.addEventListener("abort", fence, { once: true });
  if (options.signal.aborted) fence();
  return { path, async close() {
    fence();
    try { await unlink(path); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  } };
}
