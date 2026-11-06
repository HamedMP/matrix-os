import { removeQuiescedCommandStaging } from "./command-artifact-cleanup.js";
import { assertCommandDirectory, COMMAND_DIRECTORY_MODE } from "./command-ipc-policy.js";
import { chmod, lstat, mkdir, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeHandleSchema } from "./protocol.js";
import { assertRuntimeDirectoryPlacement, trustedIpcGroup, HOST_NAMESPACE_TRUST, type RuntimeDirectoryRoots } from "./namespace-ancestry.js";

const MAX_ENTRIES = 128;

async function assertDirectoryIfPresent(path: string, uid?: number): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (uid !== undefined && entry.uid !== uid)) throw new Error("Unsafe scope runtime directory");
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string, preserveVerifiedIpcMode = false): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertDirectoryIfPresent(path);
  if (preserveVerifiedIpcMode && ((await lstat(path)).mode & 0o7777) === 0o770) return;
  await chmod(path, 0o700);
}

function directoryPaths(paths: RuntimeDirectoryRoots, runtimeHandle: string) {
  const suffix = RuntimeHandleSchema.parse(runtimeHandle).slice("runtime_".length);
  const runtimeRoot = join(paths.stateRoot, "runtimes", suffix);
  return { runtimeRoot, commandDirectory: paths.commandSocketRoot ? join(paths.commandSocketRoot, suffix) : join(runtimeRoot, "command") };
}

export async function commandDirectoryForRuntime(paths: RuntimeDirectoryRoots, runtimeHandle: string): Promise<string> {
  await assertRuntimeDirectoryPlacement(paths);
  const { runtimeRoot, commandDirectory } = directoryPaths(paths, runtimeHandle);
  await assertDirectoryIfPresent(paths.stateRoot);
  await assertDirectoryIfPresent(join(paths.stateRoot, "runtimes"));
  await assertDirectoryIfPresent(runtimeRoot);
  if (paths.commandSocketRoot) await assertDirectoryIfPresent(paths.commandSocketRoot);
  if (!await assertDirectoryIfPresent(commandDirectory)) throw new Error("Scope runtime command directory unavailable");
  return commandDirectory;
}

/** Exclusive creates establish ownership; failed setup never removes a pre-existing directory/link. */
export async function createRuntimeDirectories(paths: RuntimeDirectoryRoots, runtimeHandle: string) {
  await assertRuntimeDirectoryPlacement(paths);
  await ensurePrivateDirectory(paths.stateRoot);
  const runtimesRoot = join(paths.stateRoot, "runtimes");
  await ensurePrivateDirectory(runtimesRoot);
  if (paths.commandSocketRoot) await ensurePrivateDirectory(paths.commandSocketRoot, true);
  const { runtimeRoot, commandDirectory } = directoryPaths(paths, runtimeHandle);
  const trust = paths.namespaceTrust ?? HOST_NAMESPACE_TRUST;
  const gid = await trustedIpcGroup(trust);
  await mkdir(runtimeRoot, { mode: 0o700 });
  let commandCreated = false;
  try {
    await mkdir(commandDirectory, { mode: COMMAND_DIRECTORY_MODE });
    commandCreated = true;
    await chmod(commandDirectory, COMMAND_DIRECTORY_MODE);
    assertCommandDirectory(await lstat(commandDirectory), { uid: trust.uid, gid });
    const root = join(runtimeRoot, "root");
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    return { runtimeRoot, commandDirectory, root };
  } catch (error: unknown) {
    if (paths.commandSocketRoot && commandCreated) await rm(commandDirectory, { recursive: true, force: true });
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function removeRuntimeDirectories(paths: RuntimeDirectoryRoots, runtimeHandle: string): Promise<void> {
  await assertRuntimeDirectoryPlacement(paths);
  const uid = (paths.namespaceTrust ?? HOST_NAMESPACE_TRUST).uid;
  const { runtimeRoot, commandDirectory } = directoryPaths(paths, runtimeHandle);
  await assertDirectoryIfPresent(paths.stateRoot, uid);
  await assertDirectoryIfPresent(join(paths.stateRoot, "runtimes"), uid);
  if (paths.commandSocketRoot) {
    await assertDirectoryIfPresent(paths.commandSocketRoot, uid);
  }
  await assertDirectoryIfPresent(runtimeRoot, uid);
  await assertDirectoryIfPresent(commandDirectory, uid);
  await removeQuiescedCommandStaging(commandDirectory);
  if (paths.commandSocketRoot) await rm(commandDirectory, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
}

/** Sweep each owned root independently, including command orphans left by interrupted preparation. */
export async function cleanupOrphanedRuntimeDirectories(paths: RuntimeDirectoryRoots, retainedSuffixes: ReadonlySet<string>, quiesce?: (suffix: string) => Promise<void>): Promise<void> {
  await assertRuntimeDirectoryPlacement(paths);
  const uid = (paths.namespaceTrust ?? HOST_NAMESPACE_TRUST).uid;
  const cleaned = new Set<string>(); // Local sweep only; capped at MAX_ENTRIES below.
  for (const root of [join(paths.stateRoot, "runtimes"), ...(paths.commandSocketRoot ? [paths.commandSocketRoot] : [])]) {
    await assertDirectoryIfPresent(paths.stateRoot, uid);
    if (!await assertDirectoryIfPresent(root, uid)) continue;
    const directory = await opendir(root);
    let count = 0;
    for await (const entry of directory) {
      count += 1;
      if (count > MAX_ENTRIES) throw new Error("Scope runtime reconciliation exceeds capacity");
      if (!/^[a-f0-9]{32}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Unsafe reconciled scope runtime root");
      }
      if (!retainedSuffixes.has(entry.name) && !cleaned.has(entry.name)) {
        if (!quiesce || cleaned.size >= MAX_ENTRIES) throw new Error("Scope runtime orphan cleanup authority unavailable");
        await quiesce(entry.name);
        await removeRuntimeDirectories(paths, `runtime_${entry.name}`);
        cleaned.add(entry.name);
      }
    }
  }
}
