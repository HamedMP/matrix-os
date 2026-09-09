import { readFile } from "node:fs/promises";
import { formatCodingAgentDiagnostic } from "./coding-agents/diagnostics.js";
import { boundedOperation } from "./bounded-operation.js";

type StartupStage = "launch_preflight" | "runtime_start" | "session_persist";
const ERROR_CODES = new Set(["EAGAIN", "ENOMEM", "ENOENT", "EACCES", "EPERM", "EMFILE", "ENFILE", "ETIMEDOUT", "ENOSPC"]);

function causes(error: unknown) {
  const result = [];
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const fields = current as Error & { code?: unknown; signal?: unknown };
    result.push({
      ...formatCodingAgentDiagnostic(current),
      ...(typeof fields.code === "string" && ERROR_CODES.has(fields.code) ? { code: fields.code } : {}),
      ...(typeof fields.code === "number" && Number.isSafeInteger(fields.code) ? { exitCode: fields.code } : {}),
      ...(typeof fields.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(fields.signal) ? { signal: fields.signal } : {}),
    });
    if (current.cause === current) break;
    current = current.cause;
  }
  return result.length ? result : [formatCodingAgentDiagnostic(error)];
}

type ReadCounter = (path: string) => Promise<string>;

async function counter(path: string, read: ReadCounter): Promise<{ value: string | null; unavailable?: string }> {
  try {
    const value = (await read(path)).trim();
    return /^(?:max|\d{1,20}|max \d{1,20})$/.test(value) ? { value } : { value: null, unavailable: "invalid" };
  } catch (error) {
    // Missing/unreadable cgroups mean unavailable, never zero consumption.
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    return { value: null, unavailable: missing ? "missing" : "unreadable" };
  }
}

export async function collectStartupCapacity(uid: number, read: ReadCounter = (path) => readFile(path, "utf8")) {
  const user = `/sys/fs/cgroup/user.slice/user-${uid}.slice`;
  const paths = [user, `${user}/user@${uid}.service`,
    `${user}/user@${uid}.service/matrix.slice`,
    `${user}/user@${uid}.service/matrix.slice/matrix-terminal.slice`];
  return Promise.all(paths.map(async (path, level) => ({ level,
    current: await counter(`${path}/pids.current`, read), limit: await counter(`${path}/pids.max`, read),
    events: await counter(`${path}/pids.events`, read),
  })));
}

async function capacityAtFailure() {
  if (process.platform !== "linux" || !process.getuid) return null;
  try {
    return await boundedOperation(() => collectStartupCapacity(process.getuid!()), 1_000);
  } catch (error) {
    return { unavailable: "snapshot_failed", diagnostic: formatCodingAgentDiagnostic(error) };
  }
}

/** Private structured logs only: no prompts, paths, environment, or raw errors reach Chat. */
export async function logSessionStartupFailure(stage: StartupStage, sessionId: string, error: unknown): Promise<void> {
  console.warn("[agent-session-manager] Session startup failed", {
    stage, sessionId, occurredAt: new Date().toISOString(), causes: causes(error),
    capacity: await capacityAtFailure(),
  });
}
