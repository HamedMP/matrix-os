/**
 * Matrix files source: where files may be read and how. A root is accepted only when its real path is exactly
 * `<real home>/<root>` (no symlink anywhere on the way) and is a directory. The walk never follows a symlink, skips
 * hidden names, node_modules and folders with a secret-like name, visits names in code-unit order and can resume
 * after any root-relative path. A file is opened with O_NOFOLLOW and must be the same regular file at the moment it is
 * read, with its parent still inside the root, within the size bound and the page's remaining read budget, valid utf8
 * and free of NUL bytes.
 */
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSecretLikeName, isSkippedName } from "./config.js";
import { BRAIN_MATRIX_LIMITS, BrainMatrixPathError } from "./types.js";

/** realpath / lstat / open failures that mean "this entry is not there any more". */
const GONE_ERRNO: readonly string[] = ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "ENAMETOOLONG"];

export function isGoneError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && GONE_ERRNO.includes(error.code);
}

/** The real home directory; a home that is missing or not a directory refuses the run. */
export async function realHomeDirectory(homePath: string): Promise<string> {
  try {
    const real = await realpath(homePath);
    if (!(await lstat(real)).isDirectory()) throw new BrainMatrixPathError();
    return real;
  } catch (error: unknown) {
    if (isGoneError(error)) throw new BrainMatrixPathError({ cause: error });
    throw error;
  }
}

/**
 * The absolute directory of a root, or null when the root does not exist (its files are gone). A root reached
 * through a symlink, or that is not a directory, refuses the run.
 */
export async function rootDirectory(realHome: string, root: string): Promise<string | null> {
  const expected = join(realHome, ...root.split("/"));
  let real: string;
  try {
    real = await realpath(expected);
  } catch (error: unknown) {
    if (isGoneError(error)) return null;
    throw error;
  }
  if (real !== expected || !(await lstat(real)).isDirectory()) throw new BrainMatrixPathError();
  return real;
}

/** Order of the walk: segment by segment in code-unit order, a prefix before what extends it. */
export function compareSegments(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length - b.length;
}

export interface WalkBudget {
  /** Entries examined; the walk stops (and can resume) when it runs out. */
  entries: number;
  /** utf8 bytes a root-relative path may take; longer paths are left out. */
  readonly pathBytes: number;
  /** The last entry whose visit is complete (a file handled by the caller, or a directory entered). */
  position: readonly string[] | null;
  readonly truncated: () => void;
}

export interface WalkEntry { readonly segments: readonly string[]; readonly path: string }

async function sortedEntries(directory: string, budget: WalkBudget) {
  const entries: { name: string; kind: "file" | "directory" }[] = [];
  // Every entry read counts, skipped ones too, so no folder is read past dirEntriesMax.
  let examined = 0;
  // The async iterator closes the directory when the loop ends, breaks or throws.
  for await (const entry of await opendir(directory, { bufferSize: 64 })) {
    if (examined >= BRAIN_MATRIX_LIMITS.dirEntriesMax) {
      budget.truncated();
      break;
    }
    examined += 1;
    if (isSkippedName(entry.name)) continue;
    if (entry.isFile()) entries.push({ name: entry.name, kind: "file" });
    else if (entry.isDirectory() && !isSecretLikeName(entry.name)) entries.push({ name: entry.name, kind: "directory" });
  }
  // Names in one directory are unique, so the order is total.
  return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Regular files below `directory` that come after `after` in walk order, lazily. A directory equal to `after` was
 * entered but maybe not finished, so it is walked again from its start. Directories whose real path moved (a swap
 * for a symlink mid-walk) or that vanished are skipped.
 */
export async function* walkFiles(
  directory: string, prefix: readonly string[], after: readonly string[] | null, budget: WalkBudget,
): AsyncGenerator<WalkEntry> {
  let entries: Awaited<ReturnType<typeof sortedEntries>>;
  try {
    if ((await realpath(directory)) !== directory) return;
    entries = await sortedEntries(directory, budget);
  } catch (error: unknown) {
    if (isGoneError(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const segments = [...prefix, entry.name];
    const order = after === null ? 1 : compareSegments(segments, after);
    const onPath = after !== null && after.length > segments.length
      && compareSegments(after.slice(0, segments.length), segments) === 0;
    if (!onPath && (order < 0 || (order === 0 && entry.kind === "file"))) continue;
    // Entries before the resume point cost a comparison only, so every page makes progress.
    if (budget.entries <= 0) return;
    budget.entries -= 1;
    const path = join(directory, entry.name);
    if (Buffer.byteLength(segments.join("/"), "utf8") > budget.pathBytes) {
      budget.truncated();
      budget.position = segments;
    } else if (entry.kind === "file") {
      yield { segments, path };
    } else if (segments.length >= BRAIN_MATRIX_LIMITS.fileDepthMax) {
      budget.truncated();
      budget.position = segments;
    } else {
      budget.position = segments;
      yield* walkFiles(path, segments, onPath ? after : null, budget);
    }
  }
}

/** bytes: what was read, counted against the page's read budget whatever the outcome. */
export type FileReadOutcome =
  | { readonly kind: "text"; readonly text: string; readonly mtime: Date; readonly bytes: number }
  | { readonly kind: "binary"; readonly bytes: number }
  | { readonly kind: "too_large" } | { readonly kind: "no_room" } | { readonly kind: "gone" };

/**
 * Reads one file the walk found, refusing anything that is not a regular file whose parent still resolves to itself
 * (no symlink swapped in on the way). A file over maxBytes is
 * too_large; one over roomBytes (what is left of the page's read budget) is no_room and is read on a later page.
 */
export async function readTextFile(path: string, maxBytes: number, roomBytes = maxBytes): Promise<FileReadOutcome> {
  let handle;
  try {
    const seen = await lstat(path);
    if (!seen.isFile()) return { kind: "gone" };
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile() || stats.ino !== seen.ino || stats.dev !== seen.dev) return { kind: "gone" };
    // O_NOFOLLOW guards the last segment only: a folder swapped for a symlink since the walk listed it is caught
    // here, and so is a swap back after the open (the open file is then not the one at the path).
    const parent = dirname(path);
    if ((await realpath(parent)) !== parent) return { kind: "gone" };
    const again = await lstat(path);
    if (again.ino !== stats.ino || again.dev !== stats.dev) return { kind: "gone" };
    if (stats.size > maxBytes) return { kind: "too_large" };
    if (stats.size > roomBytes) return { kind: "no_room" };
    // Reads the size seen at open; bytes appended later wait for the next pass. A read may return fewer bytes than
    // asked, so it repeats until that size or the end of the file (each round reads at least one byte).
    const buffer = Buffer.alloc(stats.size);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const bytes = buffer.subarray(0, filled);
    if (bytes.includes(0) || !isUtf8(bytes)) return { kind: "binary", bytes: filled };
    return { kind: "text", text: bytes.toString("utf8"), mtime: stats.mtime, bytes: filled };
  } catch (error: unknown) {
    if (isGoneError(error)) return { kind: "gone" };
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Whether a stored file ref still names a readable regular file inside its root (the sweep check). */
export async function fileStillPresent(realHome: string, relativePath: string, maxBytes: number): Promise<boolean> {
  const segments = relativePath.split("/");
  const parent = join(realHome, ...segments.slice(0, -1));
  try {
    if ((await realpath(parent)) !== parent) return false;
    const stats = await lstat(join(parent, segments[segments.length - 1]!));
    return stats.isFile() && stats.size <= maxBytes;
  } catch (error: unknown) {
    if (isGoneError(error)) return false;
    throw error;
  }
}
