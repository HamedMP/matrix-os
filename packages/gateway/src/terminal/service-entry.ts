import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPinnedTerminalRuntime } from "@matrix-os/terminal-runtime/generation-closure";
import { attachManagedLaunchWrapper } from "../coding-agents/managed-launch-wrapper.mjs";
import { readTerminalHostDescriptor } from "./host-descriptor.js";
// Exact same anonymous-FD wrapper as Chat; application protocol and held child are Terminal-specific.
const directory = dirname(fileURLToPath(import.meta.url)), path = process.argv[2] ?? "";
const { descriptor, digest } = await readTerminalHostDescriptor(path, process.argv[3]);
await assertPinnedTerminalRuntime(directory, descriptor.generation);
const child = spawn(join(directory, "node"), [join(directory, "terminal-host.mjs"), path, digest], {
  cwd: descriptor.launch.cwd, env: { HOME: descriptor.launch.env.HOME, PATH: "/usr/bin:/bin", INVOCATION_ID: process.env.INVOCATION_ID },
  stdio: ["pipe", "pipe", "pipe", "ipc"], serialization: "json",
});
const channel = attachManagedLaunchWrapper(child, digest, undefined, "terminal");
// Native output belongs to the PTY, never this pipe. Drain bounded diagnostic output
// without coupling a log/pipe failure to the held native workload's lifetime.
let diagnosticBytes = 0;
for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (bytes: Buffer) => {
  diagnosticBytes = Math.min(16385, diagnosticBytes + bytes.length);
  if (diagnosticBytes > 16384) channel.close();
});
const stop = (signal: NodeJS.Signals) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
process.on("SIGTERM", () => stop("SIGTERM")); process.on("SIGINT", () => stop("SIGINT"));
const code = await new Promise<number>(resolve => { child.once("error", () => resolve(1)); child.once("close", code => resolve(code ?? 1)); });
channel.close(); process.exitCode = code;
