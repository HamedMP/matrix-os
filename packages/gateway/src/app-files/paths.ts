import { lstat, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { BigIntStats, Stats } from "node:fs";
import { isDeniedFileApiPath, isProtectedHomeSubpath, resolveWithinHome } from "../path-security.js";
import { AppFileError, errnoCode } from "./errors.js";

export async function lstatOrNull(path: string): Promise<Stats | null>;
export async function lstatOrNull(path: string, bigint: true): Promise<BigIntStats | null>;
export async function lstatOrNull(path: string, bigint = false): Promise<Stats | BigIntStats | null> {
  try { return bigint ? await lstat(path, { bigint: true }) : await lstat(path); }
  catch (error: unknown) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

interface PathWalk {
  /** An existing component is a symlink. */
  symlink: boolean;
  /** An existing component before the last one is not a directory. */
  nonDirectoryAncestor: boolean;
  /** The deepest existing component, or the home itself. */
  deepest: string;
  /** Every component exists. */
  exists: boolean;
}

/** Walks the home-relative path with async `lstat`, stopping at the first missing component. */
async function walkPath(homePath: string, relativePath: string): Promise<PathWalk> {
  const segments = relativePath.split("/");
  let current = resolve(homePath);
  let deepest = current;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const entry = await lstatOrNull(current);
    if (!entry) return { symlink: false, nonDirectoryAncestor: false, deepest, exists: false };
    if (entry.isSymbolicLink()) return { symlink: true, nonDirectoryAncestor: false, deepest, exists: true };
    if (index < segments.length - 1 && !entry.isDirectory()) return { symlink: false, nonDirectoryAncestor: true, deepest, exists: true };
    deepest = current;
  }
  return { symlink: false, nonDirectoryAncestor: false, deepest, exists: true };
}

/**
 * True when any existing component of the home-relative path is a symlink.
 * Stops at the first missing component. Unlike the File API helpers, this
 * also refuses a symlinked directory whose target stays inside home, because
 * such an alias could reach a protected subtree under an unprotected name.
 */
export async function hasSymlinkComponent(homePath: string, relativePath: string): Promise<boolean> {
  return (await walkPath(homePath, relativePath)).symlink;
}

/**
 * True when the real location of `absolutePath` is the real home or inside
 * it. A component removed meanwhile answers false, so the caller refuses.
 */
async function isWithinRealHome(homePath: string, absolutePath: string): Promise<boolean> {
  try {
    const [homeReal, targetReal] = await Promise.all([realpath(resolve(homePath)), realpath(absolutePath)]);
    return targetReal === homeReal || targetReal.startsWith(`${homeReal}${sep}`);
  } catch (error: unknown) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

function guardSyntax(homePath: string, relativePath: string): string {
  const resolved = resolveWithinHome(homePath, relativePath);
  if (!resolved) throw new AppFileError("not_found", "outside home");
  if (isProtectedHomeSubpath(homePath, resolved)) throw new AppFileError("forbidden", "protected path");
  // Denied subtrees answer like a missing path so their existence is not revealed.
  if (isDeniedFileApiPath(homePath, relativePath)) throw new AppFileError("not_found", "denied path");
  return resolved;
}

/**
 * Resolve a path that must already exist, for list, stat and read. All
 * checks are async so a slow disk never blocks other gateway requests.
 */
export async function resolveExistingAppFilePath(homePath: string, relativePath: string): Promise<string> {
  const resolved = guardSyntax(homePath, relativePath);
  const walk = await walkPath(homePath, relativePath);
  if (walk.symlink) throw new AppFileError("forbidden", "symlink");
  if (!walk.exists || walk.nonDirectoryAncestor) throw new AppFileError("not_found");
  if (!await isWithinRealHome(homePath, resolved)) throw new AppFileError("not_found");
  return resolved;
}

/** Resolve the target of a write or mkdir. The target itself may be missing. */
export async function resolveWritableAppFilePath(homePath: string, relativePath: string): Promise<string> {
  const resolved = guardSyntax(homePath, relativePath);
  const walk = await walkPath(homePath, relativePath);
  if (walk.symlink) throw new AppFileError("forbidden", "symlink");
  if (walk.nonDirectoryAncestor || !await isWithinRealHome(homePath, walk.deepest)) {
    throw new AppFileError("forbidden", "unwritable path");
  }
  return resolved;
}

/** Listing filter: never expose symlinks, protected or denied entries. */
export function isListableChild(homePath: string, childRelativePath: string): boolean {
  const resolved = resolveWithinHome(homePath, childRelativePath);
  return resolved !== null
    && !isProtectedHomeSubpath(homePath, resolved)
    && !isDeniedFileApiPath(homePath, childRelativePath);
}

/**
 * The location the collaboration fence matches against project roots for an
 * app write or mkdir: the lexical location under the configured home. It
 * touches no disk; the admission moves it into the home's real location,
 * resolved asynchronously, where project roots are matched too. A path
 * through a symlink inside home is refused by the operation's own async
 * checks inside the held admission. Denied subtrees stay unfenced so they
 * keep answering not found.
 */
export function appFileFenceTarget(homePath: string, relativePath: string): string | null {
  if (isDeniedFileApiPath(homePath, relativePath)) return null;
  return resolveWithinHome(homePath, relativePath);
}
