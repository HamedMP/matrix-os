import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assertPinnedTerminalRuntime } from "@matrix-os/terminal-runtime/generation-closure";
import { readTerminalHostDescriptor } from "./host-descriptor.js";
import type { TerminalHostIpc } from "./host-channel.js";
import { startOwnedTerminalHost } from "./owned-host.js";
import { validateTerminalLoginEnvironment } from "./login-environment.js";
// Compiled as terminal-host.mjs inside a complete immutable generation.
const directory = dirname(fileURLToPath(import.meta.url));
const { descriptor, digest } = await readTerminalHostDescriptor(process.argv[2] ?? "", process.argv[3]);
await assertPinnedTerminalRuntime(directory, descriptor.generation);
const login = descriptor.launch.profile === "login-shell"
  ? await new Promise<Record<string, string>>((resolve, reject) => {
    const unavailable = () => finish(new Error("Terminal login environment unavailable"));
    const onMessage = (raw: unknown) => {
      try { finish(undefined, validateTerminalLoginEnvironment(raw).env); }
      catch (error) { if (error instanceof Error) finish(error); else unavailable(); }
    };
    const deadline = setTimeout(unavailable, 5000);
    function finish(error?: Error, env?: Record<string, string>) {
      clearTimeout(deadline); process.off("message", onMessage); process.off("disconnect", unavailable);
      if (env) resolve(env); else reject(error);
    }
    if (!process.connected) { unavailable(); return; }
    process.once("message", onMessage); process.once("disconnect", unavailable);
    process.send?.("terminal.request-login-environment", error => { if (error) unavailable(); });
  })
  : undefined;
const send = process.send?.bind(process);
const ipc: TerminalHostIpc | undefined = send ? { get connected() { return process.connected; },
  send: (frame, callback) => send(frame, callback), on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener) } : undefined;
const host = await startOwnedTerminalHost({ descriptor, digest, ipc, login,
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
