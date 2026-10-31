import { join } from "node:path";
import { createHostedTerminalPty } from "./hosted-pty.js";
import { createTerminalHostChannel, type TerminalHostIpc } from "./host-channel.js";
import { createTerminalWriterBroker } from "./writer-broker.js";
import { readLinuxProcess, sameProcess } from "./process-identity.js";
import { TerminalHostDescriptorSchema, type TerminalHostDescriptor } from "./host-descriptor.js";
/** Owns the native handle independently of the source/control channel. No restore
 * descriptor or public connector can manufacture a replacement private channel. */
export async function startOwnedTerminalHost(options: {
  descriptor: TerminalHostDescriptor; digest: string; ipc?: TerminalHostIpc;
  pty: Pick<typeof import("node-pty"), "spawn">; readProcess?: typeof readLinuxProcess;
}) {
  const descriptor = TerminalHostDescriptorSchema.parse(options.descriptor), read = options.readProcess ?? readLinuxProcess;
  const pty = await createHostedTerminalPty({ directory: descriptor.directory, launch: { ...descriptor.launch,
    env: { ...descriptor.launch.env, MATRIX_TERMINAL_ROUTINE_SOCKET: join(descriptor.directory, "routine.sock") } }, cols: descriptor.cols, rows: descriptor.rows, pty: options.pty });
  let channel: ReturnType<typeof createTerminalHostChannel> | undefined, broker: Awaited<ReturnType<typeof createTerminalWriterBroker>> | undefined;
  let cleanup: Promise<unknown> | undefined;
  const closeProof = () => {
    channel?.close(); pty.closeProof();
    if (broker && !cleanup) cleanup = broker.close().catch(error => console.warn("[terminal-host] Broker cleanup unavailable", error instanceof Error ? error.name : "UnknownError"));
  };
  try {
    if (!options.ipc?.connected) throw new Error("Private launch unavailable");
    const host = await read(process.pid), supervisor = await read(process.ppid), root = await read(pty.pid);
    if (root.ppid !== host.pid || host.ppid !== supervisor.pid || host.uid !== root.uid || host.gid !== root.gid || supervisor.uid !== host.uid || supervisor.gid !== host.gid) throw new Error("Host lineage unavailable");
    channel = createTerminalHostChannel({ transport: options.ipc, digest: options.digest, generation: descriptor.generation, signal: pty.signal,
      async identity() {
        const [actualHost, actualSupervisor, actualRoot] = await Promise.all([read(host.pid), read(supervisor.pid), read(root.pid)]);
        if (!sameProcess(host, actualHost) || !sameProcess(supervisor, actualSupervisor) || !sameProcess(root, actualRoot)
          || actualHost.ppid !== supervisor.pid || actualRoot.ppid !== host.pid) throw new Error("Host lineage unavailable");
        return { host, supervisor, root, invocationId: process.env.INVOCATION_ID ?? "" };
      } });
    channel.signal.addEventListener("abort", closeProof, { once: true });
    broker = await createTerminalWriterBroker({ directory: descriptor.directory, root, signal: channel.signal, execute: channel.execute });
    if (channel.signal.aborted) closeProof();
  } catch (error) {
    console.warn("[terminal-host] Routine proof unavailable", error instanceof Error ? error.name : "UnknownError");
    closeProof();
  }
  // Native exit alone ends the host's I/O lifetime. Source loss never resolves this promise.
  const exited = pty.exited.then(async () => { closeProof(); await cleanup; });
  // Root/proof lifetime ends immediately. Initial handoff and bounded final
  // viewer-write drainage retain only I/O, never source authority.
  const closed = exited.then(async () => { await pty.initialOutputDelivered; await pty.close({ drain: true }); });
  return { pid: pty.pid, path: pty.path, exited, closed, stop: pty.stop,
    get running() { return pty.running; }, get proofAvailable() { return !!channel && !channel.signal.aborted; } };
}
