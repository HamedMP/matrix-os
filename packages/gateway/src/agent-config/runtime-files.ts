import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { AgentConfigError } from "./errors.js";

const PersistedAgentSchema = z.object({
  messagingRuntime: z.enum(["hermes", "openclaw"]).optional(),
  revision: z.number().int().min(0).optional(),
  updatedAt: z.iso.datetime().optional(),
}).passthrough();

export const ConfigRecordSchema = z.record(z.string(), z.unknown());
const MAX_TRANSITION_MARKER_BYTES = 8 * 1024;

export const TransitionStateSchema = z.object({
  id: z.uuid(),
  from: z.enum(["hermes", "openclaw"]),
  to: z.enum(["hermes", "openclaw"]),
  state: z.enum([
    "validating",
    "pausing",
    "draining",
    "activating",
    "verifying",
    "committing",
    "rolling_back",
  ]),
  startedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
}).strict();

export type TransitionState = z.infer<typeof TransitionStateSchema>;

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error
    && (error as NodeJS.ErrnoException).code === code;
}

export function logBestEffortFailure(label: string, error: unknown): void {
  console.warn(
    `[agent-config] ${label}:`,
    error instanceof Error ? error.name : "UnknownError",
  );
}

export async function readConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    throw new AgentConfigError("agent_config_invalid", error);
  }
  try {
    return ConfigRecordSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new AgentConfigError("agent_config_invalid", error);
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  try {
    file = await open(tempPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(tempPath, path);
  } finally {
    await file?.close().catch((error: unknown) => {
      logBestEffortFailure("Temporary config file close failed", error);
    });
    await unlink(tempPath).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  let file: FileHandle;
  try {
    file = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      throw new AgentConfigError("agent_config_conflict");
    }
    throw new AgentConfigError("runtime_switch_failed", error);
  }
  return async () => {
    await file.close();
    await unlink(lockPath).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  };
}

export function readAgentConfig(config: Record<string, unknown>) {
  if (config.agent === undefined) return { value: {}, stored: {} };
  const parsed = PersistedAgentSchema.safeParse(config.agent);
  if (!parsed.success) throw new AgentConfigError("agent_config_invalid", parsed.error);
  return {
    value: parsed.data,
    stored: { ...(config.agent as Record<string, unknown>) },
  };
}

export async function validateStartupTransitionMarker(
  transitionPath: string,
): Promise<void> {
  let markerStat;
  try {
    markerStat = await lstat(transitionPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    console.warn(
      "[agent-config] Runtime transition marker check failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return;
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    console.warn("[agent-config] Ignoring untrusted runtime transition marker");
    return;
  }
  if (markerStat.size > MAX_TRANSITION_MARKER_BYTES) {
    console.warn(
      "[agent-config] Ignoring invalid runtime transition marker:",
      "ResourceLimitError",
    );
    return;
  }

  let file: FileHandle | undefined;
  try {
    file = await open(
      transitionPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const openedStat = await file.stat();
    if (!openedStat.isFile() || openedStat.size > MAX_TRANSITION_MARKER_BYTES) {
      throw new RangeError("Invalid transition marker size");
    }
    const buffer = Buffer.alloc(MAX_TRANSITION_MARKER_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TRANSITION_MARKER_BYTES) {
      throw new RangeError("Invalid transition marker size");
    }
    TransitionStateSchema.parse(JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    ));
  } catch (error) {
    console.warn(
      "[agent-config] Ignoring invalid runtime transition marker:",
      error instanceof Error ? error.name : "UnknownError",
    );
  } finally {
    await file?.close().catch((error: unknown) => {
      logBestEffortFailure("Transition marker close failed", error);
    });
  }
}
