import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BigIntStats, Stats } from "node:fs";
import {
  isDeniedFileApiPath, isProtectedHomeSubpath, resolveExistingFileApiPath, resolveWithinHome, resolveWritableFileApiPath,
} from "../path-security.js";
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

/**
 * True when any existing component of the home-relative path is a symlink.
 * Stops at the first missing component. Unlike the File API helpers, this
 * also refuses a symlinked directory whose target stays inside home, because
 * such an alias could reach a protected subtree under an unprotected name.
 */
export async function hasSymlinkComponent(homePath: string, relativePath: string): Promise<boolean> {
  let current = resolve(homePath);
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    const entry = await lstatOrNull(current);
    if (!entry) return false;
    if (entry.isSymbolicLink()) return true;
  }
  return false;
}

function guardSyntax(homePath: string, relativePath: string): string {
  const resolved = resolveWithinHome(homePath, relativePath);
  if (!resolved) throw new AppFileError("not_found", "outside home");
  if (isProtectedHomeSubpath(homePath, resolved)) throw new AppFileError("forbidden", "protected path");
  // Denied subtrees answer like a missing path so their existence is not revealed.
  if (isDeniedFileApiPath(homePath, relativePath)) throw new AppFileError("not_found", "denied path");
  return resolved;
}

function callPathHelper(helper: () => string | null): string | null {
  try { return helper(); }
  catch (error: unknown) {
    // The File API helpers use sync fs; a racing delete surfaces here.
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Resolve a path that must already exist, for list, stat and read. */
export async function resolveExistingAppFilePath(homePath: string, relativePath: string): Promise<string> {
  guardSyntax(homePath, relativePath);
  if (await hasSymlinkComponent(homePath, relativePath)) throw new AppFileError("forbidden", "symlink");
  const resolved = callPathHelper(() => resolveExistingFileApiPath(homePath, relativePath));
  if (!resolved) throw new AppFileError("not_found");
  return resolved;
}

/** Resolve the target of a write or mkdir. The target itself may be missing. */
export async function resolveWritableAppFilePath(homePath: string, relativePath: string): Promise<string> {
  guardSyntax(homePath, relativePath);
  if (await hasSymlinkComponent(homePath, relativePath)) throw new AppFileError("forbidden", "symlink");
  const resolved = callPathHelper(() => resolveWritableFileApiPath(homePath, relativePath));
  if (!resolved) throw new AppFileError("forbidden", "unwritable path");
  return resolved;
}

/** Listing filter: never expose symlinks, protected or denied entries. */
export function isListableChild(homePath: string, childRelativePath: string): boolean {
  const resolved = resolveWithinHome(homePath, childRelativePath);
  return resolved !== null
    && !isProtectedHomeSubpath(homePath, resolved)
    && !isDeniedFileApiPath(homePath, childRelativePath);
}
