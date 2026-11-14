import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assertPinnedTerminalRuntime } from "@matrix-os/terminal-runtime/generation-closure";
import { readTerminalHostDescriptor } from "./host-descriptor.js";
import type { TerminalHostIpc } from "./host-channel.js";
import { startOwnedTerminalHost } from "./owned-host.js";
// Compiled as terminal-host.mjs inside a complete immutable generation.
const directory = dirname(fileURLToPath(import.meta.url));
const { descriptor, digest } = await readTerminalHostDescriptor(process.argv[2] ?? "", process.argv[3]);
await assertPinnedTerminalRuntime(directory, descriptor.generation);
const send = process.send?.bind(process);
const ipc: TerminalHostIpc | undefined = send ? { get connected() { return process.connected; },
  send: (frame, callback) => send(frame, callback), on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener) } : undefined;
const host = await startOwnedTerminalHost({ descriptor, digest, ipc,
  pty: createRequire(import.meta.url)(join(directory, "node_modules/node-pty/lib/index.js")) as typeof import("node-pty") });
let stopping = false;
const stop = () => {
  if (stopping) return; stopping = true;
  void host.stop().catch(error => { stopping = false; console.warn("[terminal-host] Stop unconfirmed", error instanceof Error ? error.name : "UnknownError"); });
};
process.on("SIGTERM", stop); process.on("SIGINT", stop);
await host.closed;
process.off("SIGTERM", stop); process.off("SIGINT", stop);
if (process.connected) process.disconnect?.();
