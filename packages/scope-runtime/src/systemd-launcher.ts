import { assertProtectedNodeRoot, nodeMount, nodeProfileDigest, ownedNodeForNamespace, WORKER_NODE_BINARY, type OwnedNode } from "./node-runtime.js";
import { assertNamespaceDirectory, assertNamespaceSocket, assertRuntimeDirectoryPlacement, HOST_NAMESPACE_TRUST, type NamespacePathTrust } from "./namespace-ancestry.js";
import { pinScopeRuntimeCommandSocket, type CommandSocketPinner } from "./command-socket-pin.js";
import { cleanupOrphanedRuntimeDirectories, commandDirectoryForRuntime, createRuntimeDirectories, removeRuntimeDirectories } from "./runtime-directories.js";
import { createScopeRuntimeUnitIdentity } from "./systemd-unit-identity.js";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
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
import { createConnection } from "node:net";
import {
  RuntimeHandleSchema,
  ScopeHandleSchema,
  ScopeRuntimeBotWorkerReplySchema,
  ScopeRuntimeResponseSchema,
  type ScopeRuntimeBotCommand,
  type ScopeRuntimeBotWorkerReply,
} from "./protocol.js";
import {
  BOT_RUNTIME_ENTRY,
  SCOPE_RUNTIME_BOT_ADAPTER_ID,
  SCOPE_RUNTIME_BOT_HARNESS_VERSION,
  SCOPE_RUNTIME_BOT_PROFILE_ID,
  piProfileIdentity,
  runtimeProfileIdentity,
  isBotAdapter,
  materializeBotSystemdProperties,
  type ScopeRuntimeBotProfilePaths,
} from "./bot-profile.js";
import {
  FIXED_SYSTEMD_ENVIRONMENT,
  SCOPE_RUNTIME_CODEX_VERSION,
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
import { scopeRuntimeWorkerFailureForExitCode } from "./worker-common.js";
import {
  SCOPE_RUNTIME_SANDBOX_CAPABILITY,
  assertSandboxEnvironment,
  buildSandboxSystemdProperties,
  validateSandboxMountSources,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024;
const READINESS_RELATIVE_PATH = "run/matrix-scope-readiness/ready";
const PROVENANCE_FILE = "provenance.json";
const MAX_RECONCILED_ENTRIES = 128;
const MAX_PROVENANCE_BYTES = 2_048;
const EXECUTION_GENERATION = /^(0|[1-9][0-9]{0,19})$/;
const WORKER_SOCKET_FILE = "worker.sock";
const MAX_WORKER_FRAME_BYTES = 128 * 1024;
/** A busy bot turn ends with its caller/worker lease; controls remain bounded. */
const BOT_CONTROL_TIMEOUT_MS = 15_000;
const MAX_BOT_REPLY_FRAME_BYTES = 32 * 1024;
const BOT_WORKER_ENTRY_FILE = "bot-worker.mjs";

export interface ScopeRuntimeCommandRunner {
  (command: string, args: readonly string[]): Promise<{ stdout: string }>;
}

interface LauncherPaths {
  namespace?: string;
  useOwnedNode?: boolean;
  namespaceTrust?: NamespacePathTrust;
  commandSocketRoot?: string;
  stateRoot: string;
  sdkDirectory: string;
  nativeDirectory: string;
  workerFile: string;
  brokerSocket: string;
  nodeBinary?: string;
  codexBinary?: string;
  /** S07: host directories under which sandbox worktrees may be bound. Empty means no sandboxed launch. */
  sandboxRoots?: readonly string[];
  /** Host directory holding the bundled bot worker; absent disables the bot profile. */
  botRuntimeDirectory?: string;
  /** Bot workspaces a `bot_agent` workload may bind; shared-chat roots never apply to bots. */
  botSandboxRoots?: readonly string[];
  /** Ordinary managed Chat roots; recipe Bot launches never use this allowlist. */
  managedPiSandboxRoots?: readonly string[];
}

type ResolvedLauncherPaths = Required<Omit<LauncherPaths, "botRuntimeDirectory" | "namespace" | "namespaceTrust" | "commandSocketRoot" | "useOwnedNode">> & { ownedNode?: OwnedNode; botRuntimeDirectory?: string; commandSocketRoot?: string; namespaceTrust?: NamespacePathTrust };

function isPiLaunch(input: { profileId?: string }): boolean {
  return piProfileIdentity(input.profileId) !== undefined;
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
  options: { sandboxProperties?: readonly string[]; namespace?: string; useOwnedNode?: boolean } = {},
): string[] {
  const runtimeHandle = RuntimeHandleSchema.parse(input.runtimeHandle);
  const scopeHandle = ScopeHandleSchema.parse(input.scopeHandle);
  // The advertised sandbox workloads are exactly what this launcher can start (no PTY adapter is installed).
  if ((input.profileId !== undefined && input.profileId !== SCOPE_RUNTIME_PROFILE_ID)
    || input.workload !== "chat_ai" || !isFixedChatAdapter(input.adapterId, input.harnessVersion)) {
    throw new Error("Unsupported scope runtime adapter");
  }
  assertSandboxEnvironment(FIXED_SYSTEMD_ENVIRONMENT);
  const sandboxProperties = options.sandboxProperties ?? [];
  for (const property of sandboxProperties) {
    if (property.includes("\n") || property.includes("\0")) throw new Error("Invalid sandbox property");
  }
  const owned = options.useOwnedNode ? ownedNodeForNamespace(options.namespace) : undefined;
  const properties = materializeFixedSystemdProperties({
    scopeRoot: assertTrustedAbsolutePath(paths.scopeRoot),
    sdkDirectory: assertTrustedAbsolutePath(paths.sdkDirectory),
    nativeDirectory: assertTrustedAbsolutePath(paths.nativeDirectory),
    workerFile: assertTrustedAbsolutePath(paths.workerFile),
    brokerSocket: assertTrustedAbsolutePath(paths.brokerSocket),
    readinessFile: assertTrustedAbsolutePath(paths.readinessFile),
    commandDirectory: assertTrustedAbsolutePath(paths.commandDirectory),
  });
  return [
    `--unit=${createScopeRuntimeUnitIdentity(options.namespace).workerUnit(runtimeHandle)}`,
    "--quiet",
    "--no-block",
    ...properties.map((property) => `--property=${nodeMount(property, owned)}`),
    ...sandboxProperties.map((property) => `--property=${property}`),
    ...FIXED_SYSTEMD_ENVIRONMENT.map((entry) => `--setenv=${entry}`),
    "--",
    "/usr/bin/env",
    "-i",
    ...FIXED_SYSTEMD_ENVIRONMENT,
    owned?.workerBinary ?? assertTrustedAbsolutePath(paths.nodeBinary),
    "/opt/matrix/scope-runtime/worker.mjs",
    runtimeHandle,
    scopeHandle,
    input.workload,
    input.adapterId,
    input.harnessVersion,
    input.executionGeneration,
  ];
}

/**
 * Shared pinned Pi worker arguments. Both trusted profiles require a sandbox;
 * the launcher selects their distinct root allowlists before building these.
 */
export function buildBotSystemdRunArgs(
  input: ScopeRuntimeLaunchRequest,
  paths: ScopeRuntimeBotProfilePaths & { nodeBinary: string },
  options: { sandboxProperties: readonly string[]; namespace?: string; useOwnedNode?: boolean },
): string[] {
  const runtimeHandle = RuntimeHandleSchema.parse(input.runtimeHandle);
  const scopeHandle = ScopeHandleSchema.parse(input.scopeHandle);
  if (!isPiLaunch(input) || input.workload !== "bot_agent" || !isBotAdapter(input.adapterId, input.harnessVersion)) {
    throw new Error("Unsupported scope runtime adapter");
  }
  if (options.sandboxProperties.length === 0) throw new Error("Bot workloads require a sandbox");
  assertSandboxEnvironment(FIXED_SYSTEMD_ENVIRONMENT);
  for (const property of options.sandboxProperties) {
    if (property.includes("\n") || property.includes("\0")) throw new Error("Invalid sandbox property");
  }
  const owned = options.useOwnedNode ? ownedNodeForNamespace(options.namespace) : undefined;
  const properties = materializeBotSystemdProperties({
    scopeRoot: assertTrustedAbsolutePath(paths.scopeRoot),
    botRuntimeDirectory: assertTrustedAbsolutePath(paths.botRuntimeDirectory),
    brokerSocket: assertTrustedAbsolutePath(paths.brokerSocket),
    readinessFile: assertTrustedAbsolutePath(paths.readinessFile),
    commandDirectory: assertTrustedAbsolutePath(paths.commandDirectory),
  }, { namespace: options.namespace });
  return [
    `--unit=${createScopeRuntimeUnitIdentity(options.namespace).workerUnit(runtimeHandle)}`,
    "--quiet",
    "--no-block",
    ...properties.map((property) => `--property=${nodeMount(property, owned)}`),
    ...options.sandboxProperties.map((property) => `--property=${property}`),
    ...FIXED_SYSTEMD_ENVIRONMENT.map((entry) => `--setenv=${entry}`),
    "--",
    "/usr/bin/env",
    "-i",
    ...FIXED_SYSTEMD_ENVIRONMENT,
    owned?.workerBinary ?? assertTrustedAbsolutePath(paths.nodeBinary),
    BOT_RUNTIME_ENTRY,
    runtimeHandle,
    scopeHandle,
    input.workload,
    input.adapterId,
    input.harnessVersion,
    input.executionGeneration,
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

async function prepareRuntimeRoot(
  paths: ResolvedLauncherPaths,
  request: ScopeRuntimeLaunchRequest,
): Promise<{ root: string; readinessFile: string; commandDirectory: string }> {
  const runtimeHandle = RuntimeHandleSchema.parse(request.runtimeHandle);
  const { runtimeRoot, root, commandDirectory } = await createRuntimeDirectories(paths, runtimeHandle);
  try {
    const bot = isPiLaunch(request);
    const mountPoints = bot
      ? ["opt/matrix/scope-sdk/bot-runtime"]
      : ["opt/matrix/scope-sdk/native", "opt/matrix/scope-sdk/sdk", "opt/matrix/scope-runtime"];
    const directories = [
      "dev",
      "lib",
      "lib64",
      "opt",
      "opt/matrix",
      "opt/matrix/runtime",
      "opt/matrix/scope-sdk",
      ...mountPoints,
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
      ...runtimeProfileIdentity(request.profileId, paths.ownedNode),
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
    if (!bot) {
      const workerTarget = join(root, "opt/matrix/scope-runtime/worker.mjs");
      const workerHandle = await open(workerTarget, "wx", 0o644);
      await workerHandle.close();
    }
    const environmentTarget = join(root, "usr/bin/env");
    const environmentHandle = await open(environmentTarget, "wx", 0o755);
    await environmentHandle.close();
    await chmod(environmentTarget, 0o755);
    const brokerTarget = join(root, "run/matrix-scope/broker.sock");
    const handle = await open(brokerTarget, "wx", 0o600);
    await handle.close();
    return { root, readinessFile, commandDirectory };
  } catch (error: unknown) {
    await removeRuntimeDirectories(paths, runtimeHandle);
    throw error;
  }
}

async function runWorkerChat(
  socketPath: string,
  input: { runtimeHandle: string; executionGeneration: string; model: string; prompt: string },
): Promise<{ text: string }> {
  const frame = `${JSON.stringify({ version: 1, type: "runtime.chat", ...input })}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_WORKER_FRAME_BYTES) {
    throw new Error("Scope runtime Chat request exceeds capacity");
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let response = "";
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve({ text: text ?? "" });
    };
    socket.setEncoding("utf8");
    socket.setTimeout(60_000, () => finish(new Error("Scope runtime Chat timed out")));
    socket.once("connect", () => socket.end(frame));
    socket.once("error", () => finish(new Error("Scope runtime worker unavailable")));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_WORKER_FRAME_BYTES) {
        finish(new Error("Scope runtime Chat response exceeds capacity"));
      }
    });
    socket.once("end", () => {
      if (settled) return;
      try {
        const parsed = ScopeRuntimeResponseSchema.parse(JSON.parse(response.trim()));
        if (parsed.type !== "runtime.chat.result" || !parsed.ok
          || parsed.runtimeHandle !== input.runtimeHandle
          || parsed.executionGeneration !== input.executionGeneration) {
          finish(new Error("Scope runtime Chat failed"));
          return;
        }
        finish(undefined, parsed.text);
      } catch (error: unknown) {
        finish(new Error(error instanceof SyntaxError
          ? "Scope runtime Chat response is invalid"
          : "Scope runtime Chat failed"));
      }
    });
  });
}

async function readRuntimeProvenance(
  runtimeRoot: string,
  runtimeHandle: string,
  owned?: OwnedNode,
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
    const pi = typeof value.profileId === "string" ? piProfileIdentity(value.profileId) : undefined;
    const bot = pi !== undefined;
    if (Object.keys(value).length !== 9
      || value.version !== 1
      || value.runtimeHandle !== runtimeHandle
      || value.profileId !== (pi?.profileId ?? SCOPE_RUNTIME_PROFILE_ID)
      || value.profileVersion !== (pi?.profileVersion ?? SCOPE_RUNTIME_PROFILE_VERSION)
      || value.profileDigest !== nodeProfileDigest(pi?.profileDigest ?? SCOPE_RUNTIME_PROFILE_DIGEST, owned)
      || value.workload !== (bot ? "bot_agent" : "chat_ai")
      || typeof value.adapterId !== "string"
      || typeof value.harnessVersion !== "string"
      || !(bot ? isBotAdapter : isFixedChatAdapter)(value.adapterId, value.harnessVersion)
      || typeof value.executionGeneration !== "string"
      || !EXECUTION_GENERATION.test(value.executionGeneration)) return undefined;
    return {
      runtimeHandle,
      executionGeneration: value.executionGeneration,
      ...(pi ? { profileId: pi.profileId } : {}),
    };
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await handle.close();
  }
}

function isFixedChatAdapter(adapterId: string, harnessVersion: string): boolean {
  return (adapterId === "claude-code" && harnessVersion === SCOPE_RUNTIME_HARNESS_VERSION)
    || (adapterId === "codex" && harnessVersion === SCOPE_RUNTIME_CODEX_VERSION);
}

async function validateRuntimeSources(
  paths: ResolvedLauncherPaths,
  adapterId?: string,
  runCommand?: ScopeRuntimeCommandRunner,
): Promise<{
  sdkDirectory: string;
  nativeDirectory: string;
  workerFile: string;
}> {
  const worker = await lstat(paths.workerFile);
  if (!worker.isFile() || worker.isSymbolicLink()) throw new Error("Scope runtime worker unavailable");
  const sdkDirectory = await realpath(paths.sdkDirectory);
  const nativeDirectory = await realpath(paths.nativeDirectory);
  const workerFile = await realpath(paths.workerFile);
  await access(join(sdkDirectory, "sdk.mjs"), constants.R_OK);
  await access(join(nativeDirectory, "claude"), constants.X_OK);
  await access("/usr/bin/env", constants.X_OK);
  await access(paths.nodeBinary, constants.X_OK);
  if (adapterId === "codex" && paths.ownedNode) throw new Error("Codex unavailable in owned Node runtime");
  if (adapterId === "codex") await verifyCodexBinary(paths.codexBinary, runCommand ?? defaultRunCommand);
  return { sdkDirectory, nativeDirectory, workerFile };
}

/** The bundled bot worker: a real directory holding a regular entry file, never a symbolic link. */
async function validateBotRuntimeSources(paths: ResolvedLauncherPaths): Promise<{ botRuntimeDirectory: string }> {
  if (!paths.botRuntimeDirectory) throw new Error("Bot runtime is not installed");
  const botRuntimeDirectory = await realpath(paths.botRuntimeDirectory);
  const directory = await lstat(botRuntimeDirectory);
  if (!directory.isDirectory()) throw new Error("Bot runtime is unavailable");
  const entry = await lstat(join(botRuntimeDirectory, BOT_WORKER_ENTRY_FILE));
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Bot runtime is unavailable");
  await access(join(botRuntimeDirectory, BOT_WORKER_ENTRY_FILE), constants.R_OK);
  await access("/usr/bin/env", constants.X_OK);
  await access(paths.nodeBinary, constants.X_OK);
  return { botRuntimeDirectory };
}

async function validateBrokerSocket(path: string): Promise<void> {
  const broker = await lstat(path);
  if (!broker.isSocket() || broker.isSymbolicLink()) throw new Error("Scope runtime broker unavailable");
}

async function runWorkerBotCommand(
  socketPath: string,
  input: { runtimeHandle: string; executionGeneration: string; command: ScopeRuntimeBotCommand; signal?: AbortSignal },
): Promise<ScopeRuntimeBotWorkerReply> {
  const { signal, ...request } = input;
  const frame = `${JSON.stringify({ version: 1, type: "runtime.bot", ...request })}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_WORKER_FRAME_BYTES) {
    throw new Error("Scope runtime bot command exceeds capacity");
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let response = "";
    let settled = false;
    const finish = (error?: Error, reply?: ScopeRuntimeBotWorkerReply) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      if (error || !reply) reject(error ?? new Error("Scope runtime bot command failed"));
      else resolve(reply);
    };
    const aborted = () => finish(new Error("Scope runtime bot command cancelled"));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    socket.setEncoding("utf8");
    socket.setTimeout(BOT_CONTROL_TIMEOUT_MS, () => finish(new Error("Scope runtime bot command timed out")));
    socket.once("connect", () => {
      if (input.command.kind === "bot.run") { socket.setTimeout(0); socket.write(frame); }
      else socket.end(frame);
    });
    socket.once("error", () => finish(new Error("Scope runtime worker unavailable")));
    socket.once("close", () => finish(new Error("Scope runtime worker disconnected")));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, "utf8") > MAX_BOT_REPLY_FRAME_BYTES) {
        finish(new Error("Scope runtime bot reply exceeds capacity"));
      }
    });
    socket.once("end", () => {
      try {
        finish(undefined, ScopeRuntimeBotWorkerReplySchema.parse(JSON.parse(response.trim())));
      } catch (error: unknown) {
        finish(new Error(error instanceof SyntaxError
          ? "Scope runtime bot reply is invalid"
          : "Scope runtime bot command failed"));
      }
    });
  });
}

async function verifyCodexBinary(
  codexBinary: string,
  runCommand: ScopeRuntimeCommandRunner,
): Promise<void> {
  await access(codexBinary, constants.X_OK);
  const resolved = await realpath(codexBinary);
  const trustedRoot = `${dirname(dirname(codexBinary))}/`;
  if (!resolved.startsWith(trustedRoot)) throw new Error("Codex scope harness path is untrusted");
  const result = await runCommand(codexBinary, ["--version"]);
  if (result.stdout.trim() !== `codex-cli ${SCOPE_RUNTIME_CODEX_VERSION}`) {
    throw new Error("Codex scope harness version is unverified");
  }
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

export function createSystemdScopeRuntimeLauncher(
  input: LauncherPaths & { runCommand?: ScopeRuntimeCommandRunner; pinCommandSocket?: CommandSocketPinner },
): ScopeRuntimeLauncher {
  const identity = createScopeRuntimeUnitIdentity(input.namespace);
  if (input.namespace !== undefined && !input.commandSocketRoot) throw new Error("Namespaced scope runtime requires a short command socket root");
  if (input.commandSocketRoot && Buffer.byteLength(join(input.commandSocketRoot, "a".repeat(32), "inference.sock")) > 107) {
    throw new Error("Scope runtime command socket path exceeds capacity");
  }
  const ownedNode = input.useOwnedNode ? ownedNodeForNamespace(input.namespace) : undefined;
  const paths: ResolvedLauncherPaths = {
    ownedNode,
    stateRoot: assertTrustedAbsolutePath(input.stateRoot),
    ...(input.namespace !== undefined ? { namespaceTrust: input.namespaceTrust ?? HOST_NAMESPACE_TRUST } : {}),
    ...(input.commandSocketRoot ? { commandSocketRoot: assertTrustedAbsolutePath(input.commandSocketRoot) } : {}),
    sdkDirectory: assertTrustedAbsolutePath(input.sdkDirectory),
    nativeDirectory: assertTrustedAbsolutePath(input.nativeDirectory),
    workerFile: assertTrustedAbsolutePath(input.workerFile),
    brokerSocket: assertTrustedAbsolutePath(input.brokerSocket),
    nodeBinary: assertTrustedAbsolutePath(ownedNode?.binary ?? input.nodeBinary ?? WORKER_NODE_BINARY),
    codexBinary: assertTrustedAbsolutePath(input.codexBinary ?? "/opt/matrix/runtime/node/bin/codex"),
    sandboxRoots: (input.sandboxRoots ?? []).map((root) => assertTrustedAbsolutePath(root)),
    botSandboxRoots: (input.botSandboxRoots ?? []).map((root) => assertTrustedAbsolutePath(root)),
    managedPiSandboxRoots: (input.managedPiSandboxRoots ?? []).map((root) => assertTrustedAbsolutePath(root)),
    ...(input.botRuntimeDirectory ? { botRuntimeDirectory: assertTrustedAbsolutePath(input.botRuntimeDirectory) } : {}),
  };
  const verifyPlacement = async () => {
    if (ownedNode) await assertProtectedNodeRoot(ownedNode.root);
    if (!paths.namespaceTrust) return;
    await assertRuntimeDirectoryPlacement(paths);
    await assertNamespaceSocket(paths.brokerSocket, paths.namespaceTrust);
  };
  const execute = input.runCommand ?? defaultRunCommand;
  const runCommand: ScopeRuntimeCommandRunner = async (command, args) => {
    await verifyPlacement();
    return execute(command, args);
  };
  const pinCommandSocket = input.pinCommandSocket ?? pinScopeRuntimeCommandSocket;

  async function dispatchCommand<T>(runtimeHandle: string, dispatch: (path: string) => Promise<T>): Promise<T> {
    const handle = RuntimeHandleSchema.parse(runtimeHandle);
    const path = join(await commandDirectoryForRuntime(paths, handle), WORKER_SOCKET_FILE);
    const pinned = await pinCommandSocket(path);
    try { return await dispatch(pinned.path); } finally { await pinned.close(); }
  }

  return {
    profileDigest: base => nodeProfileDigest(base, ownedNode),
    async supportedAdapters(profileId?: string) {
      await verifyPlacement();
      if (piProfileIdentity(profileId)) {
        const roots = profileId === SCOPE_RUNTIME_BOT_PROFILE_ID ? paths.botSandboxRoots : paths.managedPiSandboxRoots;
        if (!paths.botRuntimeDirectory || roots.length === 0) return [];
        try {
          await validateBotRuntimeSources(paths);
          return [{
            adapterId: SCOPE_RUNTIME_BOT_ADAPTER_ID,
            harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
            workloads: ["bot_agent" as const],
          }];
        } catch (error: unknown) {
          console.warn("[scope-runtime] bot profile disabled:", error instanceof Error ? error.name : "UnknownError");
          return [];
        }
      }
      if (profileId !== undefined && profileId !== SCOPE_RUNTIME_PROFILE_ID) return [];
      await validateRuntimeSources(paths);
      const adapters = [{
        adapterId: "claude-code",
        harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
        workloads: ["chat_ai" as const],
      }];
      if (ownedNode) return adapters;
      try {
        await verifyCodexBinary(paths.codexBinary, runCommand);
        adapters.push({
          adapterId: "codex",
          harnessVersion: SCOPE_RUNTIME_CODEX_VERSION,
          workloads: ["chat_ai" as const],
        });
      } catch (error: unknown) {
        console.warn("[scope-runtime] Codex adapter disabled:",
          error instanceof Error ? error.name : "UnknownError");
      }
      return adapters;
    },
    async active(): Promise<ReadonlySet<string>> {
      const { stdout } = await runCommand("/usr/bin/systemctl", [
        "list-units",
        "--type=service",
        "--state=active",
        "--plain",
        "--no-legend",
        identity.discoveryGlob,
      ]);
      const running = new Set<string>();
      for (const line of stdout.split("\n")) {
        const name = line.trim().split(/\s+/, 1)[0];
        const handle = name ? identity.parseWorkerUnit(name) : undefined;
        if (!handle) continue;
        running.add(handle);
        if (running.size > MAX_RECONCILED_ENTRIES) throw new Error("Scope runtime liveness exceeds capacity");
      }
      return running;
    },
    async list(): Promise<ScopeRuntimeReconciledRuntime[]> {
      const { stdout } = await runCommand("/usr/bin/systemctl", [
        "list-units",
        "--type=service",
        "--all",
        "--plain",
        "--no-legend",
        identity.discoveryGlob,
      ]);
      const handles: ScopeRuntimeReconciledRuntime[] = [];
      const retainedSuffixes = new Set<string>();
      let entries = 0;
      for (const line of stdout.split("\n")) {
        const [name, , activeState] = line.trim().split(/\s+/, 4);
        if (!name) continue;
        const runtimeHandle = identity.parseWorkerUnit(name);
        if (!runtimeHandle) continue;
        entries += 1;
        if (entries > MAX_RECONCILED_ENTRIES) throw new Error("Scope runtime reconciliation exceeds capacity");
        const suffix = runtimeHandle.slice("runtime_".length);
        const ready = activeState === "active" && await readinessPublished(
          join(paths.stateRoot, "runtimes", suffix, "ready"),
          runtimeHandle,
        );
        const provenance = ready
          ? await readRuntimeProvenance(join(paths.stateRoot, "runtimes", suffix), runtimeHandle, paths.ownedNode)
          : undefined;
        if (!provenance) {
          if (!await cleanupSubmittedUnit(runCommand, name)) {
            throw new Error("Scope runtime reconciliation cleanup unavailable");
          }
          await removeRuntimeDirectories(paths, runtimeHandle);
          continue;
        }
        retainedSuffixes.add(suffix);
        handles.push(provenance);
        if (handles.length > 32) throw new Error("Scope runtime reconciliation exceeds capacity");
      }
      await cleanupOrphanedRuntimeDirectories(paths, retainedSuffixes);
      return handles;
    },
    async start(request: ScopeRuntimeLaunchRequest): Promise<void> {
      // Capability discovery runs before the gateway opens this socket. Only
      // an actual workload launch requires the broker to be listening.
      await verifyPlacement();
      await validateBrokerSocket(paths.brokerSocket);
      const { root, readinessFile, commandDirectory } = await prepareRuntimeRoot(paths, request);
      let submitted = false;
      try {
        const bot = isPiLaunch(request);
        const chatSources = bot ? undefined : await validateRuntimeSources(paths, request.adapterId, runCommand);
        const botSources = bot ? await validateBotRuntimeSources(paths) : undefined;
        const sandboxProperties = request.sandbox
          ? buildSandboxSystemdProperties(
              request.sandbox,
              await validateSandboxMountSources(request.sandbox, {
                allowedRoots: bot
                  ? request.profileId === SCOPE_RUNTIME_BOT_PROFILE_ID ? paths.botSandboxRoots : paths.managedPiSandboxRoots
                  : paths.sandboxRoots,
              }),
            )
          : undefined;
        const common = { scopeRoot: root, brokerSocket: paths.brokerSocket, readinessFile, commandDirectory, nodeBinary: paths.nodeBinary };
        const args = botSources
          ? buildBotSystemdRunArgs(request, { ...common, botRuntimeDirectory: botSources.botRuntimeDirectory }, {
              sandboxProperties: sandboxProperties ?? [], namespace: input.namespace, useOwnedNode: input.useOwnedNode,
            })
          : buildFixedSystemdRunArgs(request, { ...common, ...chatSources! }, { sandboxProperties, namespace: input.namespace, useOwnedNode: input.useOwnedNode });
        submitted = true;
        await runCommand("/usr/bin/systemd-run", args);
        await waitUntilReady(
          runCommand,
          identity.workerUnit(request.runtimeHandle),
          readinessFile,
          request.runtimeHandle,
        );
      } catch (error: unknown) {
        const cleaned = !submitted
          || await cleanupSubmittedUnit(runCommand, identity.workerUnit(request.runtimeHandle));
        if (cleaned) await removeRuntimeDirectories(paths, request.runtimeHandle);
        throw error;
      }
    },
    async runChat(input): Promise<{ text: string }> {
      if (!EXECUTION_GENERATION.test(input.executionGeneration)) {
        throw new Error("Invalid scope runtime generation");
      }
      return dispatchCommand(input.runtimeHandle, (path) => runWorkerChat(path, input));
    },
    async runBot(input): Promise<ScopeRuntimeBotWorkerReply> {
      if (!EXECUTION_GENERATION.test(input.executionGeneration)) {
        throw new Error("Invalid scope runtime generation");
      }
      return dispatchCommand(input.runtimeHandle, (path) => runWorkerBotCommand(path, input));
    },
    async stop(runtimeHandle: string): Promise<void> {
      const handle = RuntimeHandleSchema.parse(runtimeHandle);
      const name = identity.workerUnit(handle);
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
      await removeRuntimeDirectories(paths, handle);
    },
  };
}

export async function nextExecutionGeneration(path: string, namespaceTrust?: NamespacePathTrust): Promise<string> {
  const target = assertTrustedAbsolutePath(path);
  if (namespaceTrust) await assertNamespaceDirectory(dirname(target), namespaceTrust);
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
