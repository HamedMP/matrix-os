import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { assertPinnedTerminalRuntime } from "@matrix-os/terminal-runtime/generation-closure";
import { attachTerminalIo } from "./io-attach.js";
if (process.argv.length !== 3) throw new Error("Terminal attachment unavailable");
const directory = dirname(fileURLToPath(import.meta.url));
await assertPinnedTerminalRuntime(directory, (await readFile(join(directory, "GENERATION"), "utf8")).trim());
const controller = new AbortController(), stop = () => controller.abort();
process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
try {
  const attachment = await attachTerminalIo({ path: process.argv[2]!, input: process.stdin, output: process.stdout, resizeEvents: process, signal: controller.signal });
  await attachment.closed;
} finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop); }
