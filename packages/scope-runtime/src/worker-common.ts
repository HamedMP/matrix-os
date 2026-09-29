/**
 * Helpers shared by the scope-runtime Chat and bot workers: pinned harness
 * versions, the fixed environment, boundary checks, readiness, and exit
 * codes. This module has no side effects on import, so a bundled worker can
 * include it without starting another worker's entry point.
 */
import { access, constants, lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";

export const SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION = "2.1.240";
export const SCOPE_RUNTIME_CODEX_HARNESS_VERSION = "0.154.0";
export const SCOPE_RUNTIME_WORKER_HARNESS_VERSION = SCOPE_RUNTIME_CLAUDE_HARNESS_VERSION;

export const SCOPE_RUNTIME_HANDLE_PATTERN = /^runtime_[a-f0-9]{32}$/;
export const SCOPE_HANDLE_PATTERN = /^scope_[a-f0-9]{32}$/;
export const EXECUTION_GENERATION_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

const SENSITIVE_ENVIRONMENT_KEY = /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL)(?:$|_)/i;
const FORBIDDEN_PATHS = [
  "/home/matrix/home",
  "/opt/matrix/env",
  "/run/systemd/private",
  "/run/postgresql",
  "/var/run/docker.sock",
] as const;
const READINESS_DIRECTORY = "/run/matrix-scope-readiness";
const FIXED_ENVIRONMENT_SENTINEL = "--matrix-scope-fixed-environment";
const FIXED_WORKER_ENVIRONMENT = Object.freeze({
  HOME: "/workspace",
  PATH: "/opt/matrix/runtime/node/bin",
  MATRIX_SCOPE_RUNTIME: "1",
});
export const SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES = Object.freeze({
  ScopeRuntimeBrokerError: 80,
  ScopeRuntimeEnvironmentCapacityError: 81,
  ScopeRuntimeEnvironmentFixedError: 82,
  ScopeRuntimeEnvironmentKeyError: 83,
  ScopeRuntimeFilesystemError: 84,
  ScopeRuntimeIdentityUidError: 85,
  ScopeRuntimeIdentityWorkingDirectoryError: 86,
  ScopeRuntimeInvocationError: 87,
  ScopeRuntimeReadinessError: 88,
  ScopeRuntimeUnknownError: 89,
} as const);

export type ScopeRuntimeWorkerFailureName = keyof typeof SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES;

export function scopeRuntimeWorkerFailure(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export function validateScopeRuntimeWorkerEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const entries = Object.entries(input);
  if (entries.length > 256) {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeEnvironmentCapacityError", "Scope runtime environment exceeds capacity");
  }
  let bytes = 0;
  for (const [key, value] of entries) {
    if (key.length > 256 || (value?.length ?? 0) > 8_192 || SENSITIVE_ENVIRONMENT_KEY.test(key)) {
      throw scopeRuntimeWorkerFailure("ScopeRuntimeEnvironmentKeyError", "Unsafe scope runtime environment");
    }
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value ?? "");
  }
  if (bytes > 64 * 1024
    || input.HOME !== "/workspace"
    || input.PATH !== "/opt/matrix/runtime/node/bin"
    || input.MATRIX_SCOPE_RUNTIME !== "1") {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeEnvironmentFixedError", "Invalid scope runtime environment");
  }
  return input;
}

export function scrubScopeRuntimeWorkerEnvironment(
  input: Record<string, string | undefined>,
): Readonly<Record<string, string | undefined>> {
  const keys = Object.keys(input);
  if (keys.length > 256) {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeEnvironmentCapacityError", "Scope runtime environment exceeds capacity");
  }
  for (const key of keys) {
    if (!Object.hasOwn(FIXED_WORKER_ENVIRONMENT, key)) delete input[key];
  }
  Object.assign(input, FIXED_WORKER_ENVIRONMENT);
  return validateScopeRuntimeWorkerEnvironment(input);
}

export function prepareScopeRuntimeWorkerEnvironment(
  args: readonly string[],
  environment: Record<string, string | undefined>,
  executable: string,
  workerFile: string,
): {
  invocationArguments?: readonly string[];
  reexec?: {
    executable: string;
    arguments: string[];
    environment: Record<string, string>;
  };
} {
  if (args[0] === FIXED_ENVIRONMENT_SENTINEL) {
    scrubScopeRuntimeWorkerEnvironment(environment);
    return { invocationArguments: args.slice(1) };
  }
  return {
    reexec: {
      executable,
      arguments: [executable, workerFile, FIXED_ENVIRONMENT_SENTINEL, ...args],
      environment: { ...FIXED_WORKER_ENVIRONMENT },
    },
  };
}

export async function verifyScopeRuntimeBoundary(): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || uid < 61_184 || uid > 65_519) {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeIdentityUidError", "Scope runtime identity unavailable");
  }
  if (process.cwd() !== "/workspace") {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeIdentityWorkingDirectoryError", "Scope runtime identity unavailable");
  }
  validateScopeRuntimeWorkerEnvironment(process.env);
  for (const path of FORBIDDEN_PATHS) {
    try {
      await access(path);
      throw scopeRuntimeWorkerFailure("ScopeRuntimeFilesystemError", "Scope runtime forbidden path is accessible");
    } catch (error: unknown) {
      if (error instanceof Error && ["ENOENT", "EACCES", "EPERM"].includes(
        String((error as NodeJS.ErrnoException).code),
      )) continue;
      throw error;
    }
  }
  const broker = await lstat("/run/matrix-scope/broker.sock");
  if (!broker.isSocket() || broker.isSymbolicLink()) {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeBrokerError", "Scope runtime broker unavailable");
  }
}

export async function writeScopeRuntimeReadiness(
  runtimeHandle: string,
  directory = READINESS_DIRECTORY,
): Promise<void> {
  if (!SCOPE_RUNTIME_HANDLE_PATTERN.test(runtimeHandle)) {
    throw scopeRuntimeWorkerFailure("ScopeRuntimeInvocationError", "Invalid scope runtime worker invocation");
  }
  const marker = await open(
    join(directory, "ready"),
    constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
  );
  try {
    await marker.writeFile(`${runtimeHandle}\n`);
  } finally {
    await marker.close();
  }
}

export function scopeRuntimeWorkerFailureName(error: unknown): ScopeRuntimeWorkerFailureName {
  const name = error instanceof Error ? error.name : "";
  return Object.hasOwn(SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES, name)
    ? name as ScopeRuntimeWorkerFailureName
    : "ScopeRuntimeUnknownError";
}

export function scopeRuntimeWorkerFailureExitCode(error: unknown): number {
  return SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES[scopeRuntimeWorkerFailureName(error)];
}

export function scopeRuntimeWorkerFailureForExitCode(
  exitCode: number,
): ScopeRuntimeWorkerFailureName | undefined {
  for (const [name, code] of Object.entries(SCOPE_RUNTIME_WORKER_FAILURE_EXIT_CODES)) {
    if (code === exitCode) return name as ScopeRuntimeWorkerFailureName;
  }
  return undefined;
}

export async function waitForScopeRuntimeShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    // Signal listeners do not keep Node's event loop alive. Without this
    // referenced handle, the top-level await exits with status 13 before the
    // supervisor can use the ready worker.
    const keepAlive = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      resolve();
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
}


/** Removes a stale command socket left by an earlier worker; anything else at that path is refused. */
export async function removeScopeRuntimeCommandSocket(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (!entry.isSocket() || entry.isSymbolicLink()) {
      throw scopeRuntimeWorkerFailure("ScopeRuntimeFilesystemError", "Invalid command socket");
    }
    await unlink(path);
  } catch (error: unknown) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
}
