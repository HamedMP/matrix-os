import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  opendir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  constants,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { RuntimeHandleSchema, ScopeHandleSchema } from "./protocol.js";
import {
  FIXED_SYSTEMD_ENVIRONMENT,
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
  materializeFixedSystemdProperties,
  type ScopeRuntimeProfilePaths,
} from "./profile.js";
import type {
  ScopeRuntimeLaunchRequest,
  ScopeRuntimeLauncher,
  ScopeRuntimeReconciledRuntime,
} from "./supervisor.js";
import { scopeRuntimeWorkerFailureForExitCode } from "./worker.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
const UNIT_PREFIX = "matrix-scope-runtime-";
const READINESS_RELATIVE_PATH = "run/matrix-scope-readiness/ready";
const PROVENANCE_FILE = "provenance.json";
const MAX_RECONCILED_ENTRIES = 128;
const MAX_PROVENANCE_BYTES = 2_048;
const EXECUTION_GENERATION = /^(0|[1-9][0-9]{0,19})$/;

export interface ScopeRuntimeCommandRunner {
  (command: string, args: readonly string[]): Promise<{ stdout: string }>;
}

interface LauncherPaths {
  stateRoot: string;
  sdkDirectory: string;
  nativeDirectory: string;
  workerFile: string;
  brokerSocket: string;
  nodeBinary?: string;
}

function unitName(runtimeHandle: string): string {
  return `${UNIT_PREFIX}${RuntimeHandleSchema.parse(runtimeHandle).slice("runtime_".length)}.service`;
}

function assertTrustedAbsolutePath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("Invalid scope runtime host path");
  }
  return value;
}

export function buildFixedSystemdRunArgs(
  input: ScopeRuntimeLaunchRequest,
  paths: ScopeRuntimeProfilePaths & { nodeBinary: string },
): string[] {
  const runtimeHandle = RuntimeHandleSchema.parse(input.runtimeHandle);
  const scopeHandle = ScopeHandleSchema.parse(input.scopeHandle);
  if (input.workload !== "chat_ai" || input.adapterId !== "claude-code"
    || input.harnessVersion !== SCOPE_RUNTIME_HARNESS_VERSION) {
    throw new Error("Unsupported scope runtime adapter");
  }
  const properties = materializeFixedSystemdProperties({
    scopeRoot: assertTrustedAbsolutePath(paths.scopeRoot),
    sdkDirectory: assertTrustedAbsolutePath(paths.sdkDirectory),
    nativeDirectory: assertTrustedAbsolutePath(paths.nativeDirectory),
    workerFile: assertTrustedAbsolutePath(paths.workerFile),
    brokerSocket: assertTrustedAbsolutePath(paths.brokerSocket),
    readinessFile: assertTrustedAbsolutePath(paths.readinessFile),
  });
  return [
    `--unit=${unitName(runtimeHandle)}`,
    "--quiet",
    "--no-block",
    ...properties.map((property) => `--property=${property}`),
    ...FIXED_SYSTEMD_ENVIRONMENT.map((entry) => `--setenv=${entry}`),
    "--",
    "/usr/bin/env",
    "-i",
    ...FIXED_SYSTEMD_ENVIRONMENT,
    assertTrustedAbsolutePath(paths.nodeBinary),
    "/opt/matrix/scope-runtime/worker.mjs",
    runtimeHandle,
    scopeHandle,
    input.workload,
    input.adapterId,
    input.harnessVersion,
  ];
}

async function defaultRunCommand(command: string, args: readonly string[]): Promise<{ stdout: string }> {
  const result = await execFileAsync(command, [...args], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    killSignal: "SIGKILL",
  });
  return { stdout: result.stdout };
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe scope runtime state directory");
}

async function prepareRuntimeRoot(
  stateRoot: string,
  request: ScopeRuntimeLaunchRequest,
): Promise<{ root: string; readinessFile: string }> {
  const runtimeHandle = RuntimeHandleSchema.parse(request.runtimeHandle);
  const suffix = RuntimeHandleSchema.parse(runtimeHandle).slice("runtime_".length);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await assertPrivateDirectory(stateRoot);
  const runtimesRoot = join(stateRoot, "runtimes");
  await mkdir(runtimesRoot, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(runtimesRoot);
  const runtimeRoot = join(runtimesRoot, suffix);
  await mkdir(runtimeRoot, { mode: 0o700 });
  await assertPrivateDirectory(runtimeRoot);
  const root = join(runtimeRoot, "root");
  await mkdir(root, { mode: 0o755 });
  await chmod(root, 0o755);
  const directories = [
    "dev",
    "lib",
    "lib64",
    "opt",
    "opt/matrix",
    "opt/matrix/runtime",
    "opt/matrix/scope-sdk",
    "opt/matrix/scope-sdk/native",
    "opt/matrix/scope-sdk/sdk",
    "opt/matrix/scope-runtime",
    "proc",
    "run",
    "run/matrix-scope",
    "run/matrix-scope-readiness",
    "sys",
    "tmp",
    "usr",
    "usr/bin",
    "usr/lib",
    "workspace",
  ];
  for (const relative of directories) {
    const directory = join(root, relative);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await chmod(directory, 0o755);
  }
  const readinessFile = join(runtimeRoot, "ready");
  const readinessHandle = await open(readinessFile, "wx", 0o622);
  await readinessHandle.close();
  await chmod(readinessFile, 0o622);
  const provenance = `${JSON.stringify({
    version: 1,
    runtimeHandle,
    profileId: SCOPE_RUNTIME_PROFILE_ID,
    profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
    workload: request.workload,
    adapterId: request.adapterId,
    harnessVersion: request.harnessVersion,
    executionGeneration: request.executionGeneration,
  })}\n`;
  if (Buffer.byteLength(provenance) > MAX_PROVENANCE_BYTES
    || !EXECUTION_GENERATION.test(request.executionGeneration)) {
    throw new Error("Invalid scope runtime provenance");
  }
  await writeFile(join(runtimeRoot, PROVENANCE_FILE), provenance, { flag: "wx", mode: 0o600 });
  const readinessTarget = join(root, READINESS_RELATIVE_PATH);
  const readinessTargetHandle = await open(readinessTarget, "wx", 0o644);
  await readinessTargetHandle.close();
  await chmod(readinessTarget, 0o644);
  const workerTarget = join(root, "opt/matrix/scope-runtime/worker.mjs");
  const workerHandle = await open(workerTarget, "wx", 0o644);
  await workerHandle.close();
  const environmentTarget = join(root, "usr/bin/env");
  const environmentHandle = await open(environmentTarget, "wx", 0o755);
  await environmentHandle.close();
  await chmod(environmentTarget, 0o755);
  const brokerTarget = join(root, "run/matrix-scope/broker.sock");
  const handle = await open(brokerTarget, "wx", 0o600);
  await handle.close();
  return { root, readinessFile };
}

async function readRuntimeProvenance(
  runtimeRoot: string,
  runtimeHandle: string,
): Promise<ScopeRuntimeReconciledRuntime | undefined> {
  let handle;
  try {
    handle = await open(join(runtimeRoot, PROVENANCE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (error instanceof Error && ["ENOENT", "ELOOP"].includes(
      String((error as NodeJS.ErrnoException).code),
    )) return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_PROVENANCE_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).length !== 9
      || value.version !== 1
      || value.runtimeHandle !== runtimeHandle
      || value.profileId !== SCOPE_RUNTIME_PROFILE_ID
      || value.profileVersion !== SCOPE_RUNTIME_PROFILE_VERSION
      || value.profileDigest !== SCOPE_RUNTIME_PROFILE_DIGEST
      || value.workload !== "chat_ai"
      || value.adapterId !== "claude-code"
      || value.harnessVersion !== SCOPE_RUNTIME_HARNESS_VERSION
      || typeof value.executionGeneration !== "string"
      || !EXECUTION_GENERATION.test(value.executionGeneration)) return undefined;
    return { runtimeHandle, executionGeneration: value.executionGeneration };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await handle.close();
  }
}

async function validateRuntimeSources(paths: Required<LauncherPaths>): Promise<{
  sdkDirectory: string;
  nativeDirectory: string;
  workerFile: string;
}> {
  const broker = await lstat(paths.brokerSocket);
  if (!broker.isSocket() || broker.isSymbolicLink()) throw new Error("Scope runtime broker unavailable");
  const worker = await lstat(paths.workerFile);
  if (!worker.isFile() || worker.isSymbolicLink()) throw new Error("Scope runtime worker unavailable");
  const sdkDirectory = await realpath(paths.sdkDirectory);
  const nativeDirectory = await realpath(paths.nativeDirectory);
  const workerFile = await realpath(paths.workerFile);
  await access(join(sdkDirectory, "sdk.mjs"), constants.R_OK);
  await access(join(nativeDirectory, "claude"), constants.X_OK);
  await access("/usr/bin/env", constants.X_OK);
  await access(paths.nodeBinary, constants.X_OK);
  return { sdkDirectory, nativeDirectory, workerFile };
}

function inactiveUnitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as { code?: unknown }).code;
  return code === 3 || code === 4;
}

async function waitUntilActive(runCommand: ScopeRuntimeCommandRunner, name: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await runCommand("/usr/bin/systemctl", ["is-active", "--quiet", name]);
      return;
    } catch (error: unknown) {
      lastError = error;
      if (!inactiveUnitError(error)) throw error;
      const { stdout } = await runCommand("/usr/bin/systemctl", [
        "show", name, "--property=Result", "--property=ExecMainStatus",
      ]);
      const status = /^ExecMainStatus=([1-9][0-9]{0,2})$/m.exec(stdout)?.[1];
      if (status) {
        const workerFailureName = scopeRuntimeWorkerFailureForExitCode(Number(status));
        const activationError = new Error("Scope runtime activation failed");
        activationError.name = workerFailureName ?? `ScopeRuntimeActivationStatus${status}Error`;
        throw activationError;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Scope runtime did not activate");
}

async function readinessPublished(path: string, runtimeHandle: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 128) throw new Error("Invalid scope runtime readiness marker");
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8") === `${runtimeHandle}\n`;
  } finally {
    await handle.close();
  }
}

async function waitUntilReady(
  runCommand: ScopeRuntimeCommandRunner,
  name: string,
  readinessPath: string,
  runtimeHandle: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await waitUntilActive(runCommand, name);
    if (await readinessPublished(readinessPath, runtimeHandle)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Scope runtime worker readiness unavailable");
}

async function cleanupSubmittedUnit(
  runCommand: ScopeRuntimeCommandRunner,
  name: string,
): Promise<boolean> {
  let cleaned = true;
  for (const action of ["stop", "reset-failed"] as const) {
    try {
      await runCommand("/usr/bin/systemctl", [action, name]);
    } catch (error: unknown) {
      if (!inactiveUnitError(error)) {
        cleaned = false;
        console.warn("[scope-runtime] submitted-unit cleanup failed:",
          error instanceof Error ? error.name : "UnknownError");
      }
    }
  }
  return cleaned;
}

async function cleanupOrphanedRuntimeRoots(
  stateRoot: string,
  retainedSuffixes: ReadonlySet<string>,
): Promise<void> {
  const runtimesRoot = join(stateRoot, "runtimes");
  let directory;
  try {
    directory = await opendir(runtimesRoot);
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let count = 0;
  for await (const entry of directory) {
    count += 1;
    if (count > MAX_RECONCILED_ENTRIES) throw new Error("Scope runtime reconciliation exceeds capacity");
    if (!/^[a-f0-9]{32}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Unsafe reconciled scope runtime root");
    }
    if (!retainedSuffixes.has(entry.name)) {
      await rm(join(runtimesRoot, entry.name), { recursive: true, force: true });
    }
  }
}

export function createSystemdScopeRuntimeLauncher(
  input: LauncherPaths & { runCommand?: ScopeRuntimeCommandRunner },
): ScopeRuntimeLauncher {
  const paths: Required<LauncherPaths> = {
    stateRoot: assertTrustedAbsolutePath(input.stateRoot),
    sdkDirectory: assertTrustedAbsolutePath(input.sdkDirectory),
    nativeDirectory: assertTrustedAbsolutePath(input.nativeDirectory),
    workerFile: assertTrustedAbsolutePath(input.workerFile),
    brokerSocket: assertTrustedAbsolutePath(input.brokerSocket),
    nodeBinary: assertTrustedAbsolutePath(input.nodeBinary ?? "/opt/matrix/runtime/node/bin/node"),
  };
  const runCommand = input.runCommand ?? defaultRunCommand;

  return {
    async list(): Promise<ScopeRuntimeReconciledRuntime[]> {
      const { stdout } = await runCommand("/usr/bin/systemctl", [
        "list-units",
        "--type=service",
        "--all",
        "--plain",
        "--no-legend",
        `${UNIT_PREFIX}*.service`,
      ]);
      const handles: ScopeRuntimeReconciledRuntime[] = [];
      const retainedSuffixes = new Set<string>();
      let entries = 0;
      for (const line of stdout.split("\n")) {
        const [name, , activeState] = line.trim().split(/\s+/, 4);
        if (!name) continue;
        entries += 1;
        if (entries > MAX_RECONCILED_ENTRIES) throw new Error("Scope runtime reconciliation exceeds capacity");
        const match = /^matrix-scope-runtime-([a-f0-9]{32})\.service$/.exec(name);
        if (!match) throw new Error("Invalid reconciled scope runtime unit");
        const suffix = match[1]!;
        const runtimeHandle = RuntimeHandleSchema.parse(`runtime_${suffix}`);
        const ready = activeState === "active" && await readinessPublished(
          join(paths.stateRoot, "runtimes", suffix, "ready"),
          runtimeHandle,
        );
        const provenance = ready
          ? await readRuntimeProvenance(join(paths.stateRoot, "runtimes", suffix), runtimeHandle)
          : undefined;
        if (!provenance) {
          if (!await cleanupSubmittedUnit(runCommand, name)) {
            throw new Error("Scope runtime reconciliation cleanup unavailable");
          }
          await rm(join(paths.stateRoot, "runtimes", suffix), { recursive: true, force: true });
          continue;
        }
        retainedSuffixes.add(suffix);
        handles.push(provenance);
        if (handles.length > 32) throw new Error("Scope runtime reconciliation exceeds capacity");
      }
      await cleanupOrphanedRuntimeRoots(paths.stateRoot, retainedSuffixes);
      return handles;
    },
    async start(request: ScopeRuntimeLaunchRequest): Promise<void> {
      const { root, readinessFile } = await prepareRuntimeRoot(paths.stateRoot, request);
      let submitted = false;
      try {
        const sources = await validateRuntimeSources(paths);
        const args = buildFixedSystemdRunArgs(request, {
          scopeRoot: root,
          sdkDirectory: sources.sdkDirectory,
          nativeDirectory: sources.nativeDirectory,
          workerFile: sources.workerFile,
          brokerSocket: paths.brokerSocket,
          readinessFile,
          nodeBinary: paths.nodeBinary,
        });
        submitted = true;
        await runCommand("/usr/bin/systemd-run", args);
        await waitUntilReady(
          runCommand,
          unitName(request.runtimeHandle),
          readinessFile,
          request.runtimeHandle,
        );
      } catch (error: unknown) {
        const cleaned = !submitted
          || await cleanupSubmittedUnit(runCommand, unitName(request.runtimeHandle));
        if (cleaned) await rm(dirname(root), { recursive: true, force: true });
        throw error;
      }
    },
    async stop(runtimeHandle: string): Promise<void> {
      const handle = RuntimeHandleSchema.parse(runtimeHandle);
      const name = unitName(handle);
      try {
        await runCommand("/usr/bin/systemctl", ["is-active", "--quiet", name]);
        await runCommand("/usr/bin/systemctl", ["stop", name]);
      } catch (error: unknown) {
        if (!inactiveUnitError(error)) throw error;
      }
      try {
        await runCommand("/usr/bin/systemctl", ["reset-failed", name]);
      } catch (error: unknown) {
        if (!inactiveUnitError(error)) {
          console.warn("[scope-runtime] failed-unit cleanup unavailable:",
            error instanceof Error ? error.name : "UnknownError");
        }
      }
      const suffix = handle.slice("runtime_".length);
      await rm(join(paths.stateRoot, "runtimes", suffix), { recursive: true, force: true });
    },
  };
}

export async function nextExecutionGeneration(path: string): Promise<string> {
  const target = assertTrustedAbsolutePath(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  let current = 0n;
  try {
    const raw = (await readFile(target, "utf8")).trim();
    if (!/^(0|[1-9][0-9]{0,19})$/.test(raw)) throw new Error("Invalid execution generation");
    current = BigInt(raw);
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = current + 1n;
  if (next > 9_999_999_999_999_999_999n) throw new Error("Execution generation exhausted");
  const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${next}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error: unknown) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError: unknown) {
      console.warn("[scope-runtime] generation temp cleanup failed:",
        cleanupError instanceof Error ? cleanupError.name : "UnknownError");
    }
    throw error;
  }
  return String(next);
}
