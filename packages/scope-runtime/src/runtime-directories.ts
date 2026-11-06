import { removeQuiescedCommandStaging } from "./command-artifact-cleanup.js";
import { assertInheritedDirectory, createInheritedCommandDirectory, type DirectoryChildRunner } from "./inherited-command-directory.js";
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

/** Explicit internal filesystem fixture injection, never environment or request input. */
export interface RuntimeDirectoryOperations {
  prepareAnchors?(paths: RuntimeDirectoryRoots): Promise<void>;
  createPrivate?(path: string): Promise<void>;
  runChild?: DirectoryChildRunner;
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
export async function createRuntimeDirectories(paths: RuntimeDirectoryRoots & {
  directoryOperations?: RuntimeDirectoryOperations;
}, runtimeHandle: string) {
  await assertRuntimeDirectoryPlacement(paths);
  await paths.directoryOperations?.prepareAnchors?.(paths);
  await assertRuntimeDirectoryPlacement(paths);
  const runtimesRoot = join(paths.stateRoot, "runtimes");
  const { runtimeRoot, commandDirectory } = directoryPaths(paths, runtimeHandle);
  const namespaceTrust = paths.namespaceTrust ?? HOST_NAMESPACE_TRUST;
  const trust = { uid: namespaceTrust.uid, gid: await trustedIpcGroup(namespaceTrust) };
  // PID1, not this capability-free supervisor, owns these declared anchors.
  for (const path of [paths.stateRoot, runtimesRoot]) assertInheritedDirectory(await lstat(path), trust, 0o2700);
  if (paths.commandSocketRoot) assertInheritedDirectory(await lstat(paths.commandSocketRoot), trust, 0o2770);
  if (paths.directoryOperations?.createPrivate) await paths.directoryOperations.createPrivate(runtimeRoot);
  else await mkdir(runtimeRoot, { mode: 0o700 });
  assertInheritedDirectory(await lstat(runtimeRoot), trust, 0o2700);
  // Leave uncertain creates as bounded owned orphans for the existing quiesced
  // reconciliation path. Never recursively remove a collided/substituted leaf.
  await createInheritedCommandDirectory(commandDirectory,
    trust, paths.commandSocketRoot ? 0o2770 : 0o2700, paths.directoryOperations?.runChild);
  const root = join(runtimeRoot, "root");
  await mkdir(root, { mode: 0o755 });
  await chmod(root, 0o755);
  return { runtimeRoot, commandDirectory, root };
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
