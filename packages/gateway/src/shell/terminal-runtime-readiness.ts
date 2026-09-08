import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import type { UserSystemdCommandRunner, UserSystemdTerminalDescriptor } from "./user-systemd-terminal-runtime.js";

const CAPABILITY = "// matrix-terminal-readiness: invocation-v1";
const ReadySchema = z.object({
  version: z.literal(1),
  invocationId: z.string().regex(/^[0-9a-f]{32}$/),
  generation: z.string(),
  createdAt: z.string(),
}).strict();

async function readBounded(path: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error("Invalid runtime readiness file");
      const buffer = Buffer.alloc(bytes);
      const result = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, result.bytesRead).toString("utf8");
    } finally { await handle.close(); }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** null selects legacy generations; absence of a modern signal is never permission to probe IPC. */
export async function probeKeeperReadiness(options: {
  descriptor: UserSystemdTerminalDescriptor;
  terminalRuntimeRoot: string;
  homePath: string;
  env: NodeJS.ProcessEnv;
  runCommand: UserSystemdCommandRunner;
}): Promise<boolean | null> {
  const { descriptor, homePath, runCommand } = options;
  // The capability header is part of the immutable, content-addressed keeper bytes.
  // Old generations remain runnable without rewriting their descriptors or installed assets.
  const keeper = await readBounded(join(options.terminalRuntimeRoot, "generations",
    descriptor.generation, "matrix-terminal-user-keeper.mjs"), 512);
  if (!keeper?.split("\n").includes(CAPABILITY)) return null;
  const { stdout } = await runCommand("systemctl", ["--user", "show",
    `matrix-zellij@${descriptor.runtimeId}.service`, "--property=ActiveState", "--property=InvocationID"],
  { cwd: homePath, env: options.env, timeoutMs: 2_000 });
  const invocationId = /^InvocationID=([0-9a-f]{32})$/m.exec(stdout)?.[1];
  if (!/^ActiveState=active$/m.test(stdout) || !invocationId) return false;
  const raw = await readBounded(join(homePath, "system", "terminal-runtimes", `${descriptor.runtimeId}.ready.json`), 1_025);
  if (!raw || Buffer.byteLength(raw) > 1_024) return false;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) return false; // A bounded signal write may still be in progress.
    throw error;
  }
  const ready = ReadySchema.safeParse(value);
  return ready.success && ready.data.invocationId === invocationId
    && ready.data.generation === descriptor.generation && ready.data.createdAt === descriptor.createdAt;
}
