import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  lstat,
  mkdtemp,
  rename,
  rm,
  rmdir,
  symlink,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

type ErrnoException = NodeJS.ErrnoException;

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

interface EntryIdentity extends DirectoryIdentity {
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

function isWithin(base: string, candidate: string): boolean {
  const relation = relative(base, candidate);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

async function captureDirectoryIdentity(path: string, homeRealPath: string): Promise<DirectoryIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isDirectory() || !isWithin(homeRealPath, await realpath(path))) {
    throw new Error("Directory identity is unsafe");
  }
  return { dev: stats.dev, ino: stats.ino };
}

async function validateDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  homeRealPath: string,
): Promise<void> {
  const actual = await captureDirectoryIdentity(path, homeRealPath);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error("Directory identity changed during copy");
  }
}

async function captureEntryIdentity(
  path: string,
  homeRealPath: string,
  sourceRootRealPath: string,
): Promise<EntryIdentity> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isSymbolicLink()) {
    const resolved = await realpath(path);
    if (!isWithin(homeRealPath, resolved) || !isWithin(sourceRootRealPath, resolved)) {
      throw new Error("Source entry escaped its authorized root");
    }
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}

function entryIdentityMatches(expected: EntryIdentity, actual: EntryIdentity): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.mode === actual.mode
    && expected.size === actual.size
    && expected.mtimeNs === actual.mtimeNs
    && expected.ctimeNs === actual.ctimeNs
    && expected.isDirectory === actual.isDirectory
    && expected.isFile === actual.isFile
    && expected.isSymbolicLink === actual.isSymbolicLink;
}

async function copyRegularFileExclusive(source: string, target: string): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const sourceHandle = await open(source, constants.O_RDONLY | noFollow);
  let targetHandle;
  try {
    targetHandle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o666,
    );
  } catch (error: unknown) {
    await sourceHandle.close();
    throw error;
  }
  await pipeline(sourceHandle.createReadStream(), targetHandle.createWriteStream());
}

export interface SourceIdentity {
  entryCount: number;
  xor: bigint;
  sum: bigint;
  rootCtimeNs: bigint;
}

const MAX_SNAPSHOT_ENTRIES = 10_000;
const MAX_SNAPSHOT_DEPTH = 128;
const SNAPSHOT_MASK = (1n << 256n) - 1n;

async function addSnapshotEntry(
  root: string,
  path: string,
  depth: number,
  snapshot: SourceIdentity,
): Promise<void> {
  if (depth > MAX_SNAPSHOT_DEPTH || snapshot.entryCount >= MAX_SNAPSHOT_ENTRIES) {
    throw new Error("Source snapshot limit exceeded");
  }

  const stats = await lstat(path, { bigint: true });
  const linkTarget = stats.isSymbolicLink() ? await readlink(path) : "";
  const isRoot = path === root;
  const digest = createHash("sha256")
    .update(relative(root, path))
    .update("\0")
    .update(`${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeNs}:${isRoot ? "root" : stats.ctimeNs}`)
    .update("\0")
    .update(linkTarget)
    .digest("hex");
  const value = BigInt(`0x${digest}`);
  snapshot.entryCount += 1;
  snapshot.xor ^= value;
  snapshot.sum = (snapshot.sum + value) & SNAPSHOT_MASK;
  if (isRoot) snapshot.rootCtimeNs = stats.ctimeNs;

  if (!stats.isDirectory()) return;
  const directory = await opendir(path);
  for await (const entry of directory) {
    await addSnapshotEntry(root, join(path, entry.name), depth + 1, snapshot);
  }
}

export async function captureSourceIdentity(path: string): Promise<SourceIdentity> {
  const snapshot: SourceIdentity = { entryCount: 0, xor: 0n, sum: 0n, rootCtimeNs: 0n };
  await addSnapshotEntry(path, path, 0, snapshot);
  return snapshot;
}

export function sourceIdentityMatches(expected: SourceIdentity, actual: SourceIdentity): boolean {
  return expected.entryCount === actual.entryCount
    && expected.xor === actual.xor
    && expected.sum === actual.sum
    && expected.rootCtimeNs === actual.rootCtimeNs;
}

function detachedSourceMatches(expected: SourceIdentity, actual: SourceIdentity): boolean {
  return expected.entryCount === actual.entryCount
    && expected.xor === actual.xor
    && expected.sum === actual.sum;
}

export interface SafeSourceCleanupDependencies {
  beforeDetach?: (path: string) => Promise<void>;
  removeSource?: (path: string) => Promise<void>;
}

export type SafeSourceCleanupResult =
  | { ok: true }
  | { ok: false; recoveryPath?: string };

export async function removeVerifiedSource(
  source: string,
  expectedIdentity: SourceIdentity,
  dependencies: SafeSourceCleanupDependencies = {},
): Promise<SafeSourceCleanupResult> {
  if (!sourceIdentityMatches(expectedIdentity, await captureSourceIdentity(source))) {
    return { ok: false };
  }

  await dependencies.beforeDetach?.(source);
  const recoveryDirectory = await mkdtemp(join(dirname(source), ".matrix-rename-recovery-"));
  const detachedSource = join(recoveryDirectory, basename(source));
  try {
    await rename(source, detachedSource);
  } catch (error: unknown) {
    try {
      await rmdir(recoveryDirectory);
    } catch (cleanupError: unknown) {
      console.warn("[file-ops] Failed to remove empty recovery directory:", cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    throw error;
  }

  let detachedIdentity: SourceIdentity;
  try {
    detachedIdentity = await captureSourceIdentity(detachedSource);
  } catch (error: unknown) {
    console.warn("[file-ops] Detached source verification failed:", error instanceof Error ? error.message : String(error));
    return { ok: false, recoveryPath: detachedSource };
  }
  if (!detachedSourceMatches(expectedIdentity, detachedIdentity)) {
    return { ok: false, recoveryPath: detachedSource };
  }

  try {
    const removeSource = dependencies.removeSource
      ?? ((path: string) => rm(path, { recursive: true }));
    await removeSource(detachedSource);
  } catch (error: unknown) {
    console.warn("[file-ops] Detached source cleanup failed:", error instanceof Error ? error.message : String(error));
    try {
      await lstat(detachedSource);
      return { ok: false, recoveryPath: detachedSource };
    } catch (statError: unknown) {
      if ((statError as ErrnoException).code !== "ENOENT") {
        console.warn("[file-ops] Failed to inspect recovery artifact:", statError instanceof Error ? statError.message : String(statError));
      }
      return { ok: false, recoveryPath: recoveryDirectory };
    }
  }
  try {
    await rmdir(recoveryDirectory);
    return { ok: true };
  } catch (error: unknown) {
    console.warn("[file-ops] Recovery directory cleanup failed:", error instanceof Error ? error.message : String(error));
    return { ok: false, recoveryPath: recoveryDirectory };
  }
}

export function isExclusiveDestinationConflict(error: unknown): boolean {
  const code = (error as ErrnoException).code;
  return code === "EEXIST" || code === "ERR_FS_CP_EEXIST";
}

export async function isDirectorySelfOrDescendant(source: string, target: string): Promise<boolean> {
  if (!(await lstat(source)).isDirectory()) return false;
  const relation = relative(source, target);
  return relation === ""
    || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export interface FileCopyDependencies {
  afterDirectoryClaim?: (target: string) => Promise<void>;
  afterSourceEntryInspection?: (source: string, target: string) => Promise<void>;
}

export class PartialDirectoryCopyError extends Error {
  constructor(
    readonly target: string,
    cause: unknown,
  ) {
    super("Directory copy left a partial destination", { cause });
  }
}

async function copyDirectoryContents(
  source: string,
  sourceIdentity: DirectoryIdentity,
  target: string,
  targetIdentity: DirectoryIdentity,
  homeRealPath: string,
  sourceRootRealPath: string,
  dependencies: FileCopyDependencies,
): Promise<void> {
  await validateDirectoryIdentity(source, sourceIdentity, homeRealPath);
  await validateDirectoryIdentity(target, targetIdentity, homeRealPath);
  const sourceDirectory = await opendir(source);
  for await (const entry of sourceDirectory) {
    const sourceEntry = join(source, entry.name);
    const targetEntry = join(target, entry.name);
    await validateDirectoryIdentity(source, sourceIdentity, homeRealPath);
    await validateDirectoryIdentity(target, targetIdentity, homeRealPath);
    const entryIdentity = await captureEntryIdentity(sourceEntry, homeRealPath, sourceRootRealPath);
    await dependencies.afterSourceEntryInspection?.(sourceEntry, targetEntry);
    const revalidatedEntry = await captureEntryIdentity(sourceEntry, homeRealPath, sourceRootRealPath);
    if (!entryIdentityMatches(entryIdentity, revalidatedEntry)) {
      throw new Error("Source entry identity changed during copy");
    }

    if (entryIdentity.isDirectory) {
      await mkdir(targetEntry);
      const childTargetIdentity = await captureDirectoryIdentity(targetEntry, homeRealPath);
      await copyDirectoryContents(
        sourceEntry,
        entryIdentity,
        targetEntry,
        childTargetIdentity,
        homeRealPath,
        sourceRootRealPath,
        dependencies,
      );
    } else if (entryIdentity.isFile) {
      await copyRegularFileExclusive(sourceEntry, targetEntry);
    } else if (entryIdentity.isSymbolicLink) {
      await symlink(await readlink(sourceEntry), targetEntry);
    } else {
      throw new Error("Unsupported directory entry type");
    }
    await validateDirectoryIdentity(target, targetIdentity, homeRealPath);
  }
}

export async function copyToExclusiveDestination(
  homePath: string,
  source: string,
  target: string,
  dependencies: FileCopyDependencies = {},
): Promise<void> {
  const homeRealPath = await realpath(homePath);
  if (!(await lstat(source)).isDirectory()) {
    const targetParent = dirname(target);
    const targetParentIdentity = await captureDirectoryIdentity(targetParent, homeRealPath);
    await validateDirectoryIdentity(targetParent, targetParentIdentity, homeRealPath);
    await copyRegularFileExclusive(source, target);
    await validateDirectoryIdentity(targetParent, targetParentIdentity, homeRealPath);
    return;
  }

  const sourceRootRealPath = await realpath(source);
  if (!isWithin(homeRealPath, sourceRootRealPath)) {
    throw new Error("Source directory escaped owner home");
  }
  const sourceIdentity = await captureDirectoryIdentity(source, homeRealPath);
  await mkdir(target);
  const targetIdentity = await captureDirectoryIdentity(target, homeRealPath);
  try {
    await dependencies.afterDirectoryClaim?.(target);
    await validateDirectoryIdentity(target, targetIdentity, homeRealPath);
    await validateDirectoryIdentity(source, sourceIdentity, homeRealPath);
    await copyDirectoryContents(
      source,
      sourceIdentity,
      target,
      targetIdentity,
      homeRealPath,
      sourceRootRealPath,
      dependencies,
    );
  } catch (error: unknown) {
    throw new PartialDirectoryCopyError(target, error);
  }
}
