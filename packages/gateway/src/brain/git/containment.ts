/**
 * Company Brain git adapter: where a repository may live. A checkout is
 * accepted only when its real path, its real git directory, its real common
 * directory, its real objects directory and every object alternates entry are
 * strictly inside the real Matrix home and never inside home's own history
 * (home's `.git`, the git and common directories it leads to, and their
 * objects). So a `.git` file or symlink, a linked worktree, a linked objects
 * directory or an alternates file cannot lead git to history outside home, or
 * to Matrix home's own history. Read-only filesystem checks,
 * each bounded; repository files are opened non-blocking and read only when
 * regular, so a FIFO cannot stall them; any refusal is
 * GitSourceError("not_a_repository").
 */
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { GitSourceError } from "./types.js";

/** realpath / stat / open failures that mean "this path is not a usable checkout". */
const MISSING_PATH_ERRNO: readonly string[] = ["ENOENT", "ENOTDIR", "EACCES", "ELOOP", "ENAMETOOLONG"];
const INPUT_PATH_MAX_CHARS = 4096;
/** One alternates file; git's own files are a few lines. */
const ALTERNATES_MAX_BYTES = 64 * 1024;
/** git follows alternates of alternates five levels deep. */
const ALTERNATES_MAX_DEPTH = 5;
/** Alternate object directories checked per repository, across every level. */
const ALTERNATES_MAX_ENTRIES = 64;
/** A `.git` file (`gitdir: <path>`) or a `commondir` file: one path line. */
const GIT_POINTER_MAX_BYTES = INPUT_PATH_MAX_CHARS + 64;
const GITFILE_PREFIX = "gitdir: ";
/** Opening a FIFO this way returns at once instead of waiting for a writer. */
const READ_NONBLOCKING = constants.O_RDONLY | constants.O_NONBLOCK;

export interface GitHomeBounds {
  readonly realHome: string;
  /**
   * Real paths of Matrix home's own history when home is versioned: its
   * `.git` entry, the git directory a `.git` file names, that directory's
   * common directory and the common directory's objects.
   */
  readonly homeGitPaths: readonly string[];
}

function refuse(cause?: unknown): never {
  throw new GitSourceError("not_a_repository", cause === undefined ? undefined : { cause });
}

function isMissingPathError(err: unknown): boolean {
  return err instanceof Error && "code" in err && typeof err.code === "string" && MISSING_PATH_ERRNO.includes(err.code);
}

export function assertInputPath(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.length > INPUT_PATH_MAX_CHARS) {
    throw new GitSourceError("invalid_options");
  }
  if (path.includes("\u0000") || !isAbsolute(path)) throw new GitSourceError("invalid_options");
}

/** realpath of an existing directory; a missing path, a file or a loop is not_a_repository. */
export async function realDirectory(path: string): Promise<string> {
  try {
    const real = await realpath(path);
    if (!(await stat(real)).isDirectory()) refuse();
    return real;
  } catch (err: unknown) {
    if (err instanceof GitSourceError) throw err;
    if (isMissingPathError(err)) refuse(err);
    throw err;
  }
}

/** True when `child` is strictly below `parent` (both real, absolute paths). */
export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

interface RealEntry { readonly real: string; readonly isFile: boolean; readonly isDirectory: boolean }

/** realpath and type of an existing entry, or null when the path does not resolve. */
async function realEntry(path: string): Promise<RealEntry | null> {
  try {
    const real = await realpath(path);
    const info = await stat(real);
    return { real, isFile: info.isFile(), isDirectory: info.isDirectory() };
  } catch (err: unknown) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

async function realDirectoryOrNull(path: string): Promise<string | null> {
  const entry = await realEntry(path);
  return entry !== null && entry.isDirectory ? entry.real : null;
}

/**
 * The directory a one-line git pointer file names (`gitdir: <path>` in a
 * `.git` file, `<path>` in `commondir`), or null. A relative path is joined
 * to `base` without lexical normalization, so realpath resolves `..` the way
 * git does.
 */
async function pointedDirectory(file: string, base: string, prefix: string): Promise<string | null> {
  const text = await readRegularFile(file, GIT_POINTER_MAX_BYTES);
  if (text === null) return null;
  const line = text.replace(/[\r\n]+$/, "");
  if (!line.startsWith(prefix)) return null;
  const target = line.slice(prefix.length);
  if (target === "" || target.includes("\u0000")) return null;
  return realDirectoryOrNull(isAbsolute(target) ? target : `${base}/${target}`);
}

/**
 * Where Matrix home's own history lives. git follows a `.git` file to the
 * real git directory and a `commondir` file to the shared one, so excluding
 * only `<home>/.git` would leave a git directory elsewhere in home open to a
 * project's `.git` file.
 */
async function resolveHomeGitPaths(realHome: string): Promise<string[]> {
  const dotGit = await realEntry(join(realHome, ".git"));
  if (dotGit === null) return [];
  const paths = new Set([dotGit.real]);
  const gitDir = dotGit.isFile
    ? await pointedDirectory(dotGit.real, realHome, GITFILE_PREFIX)
    : dotGit.isDirectory ? dotGit.real : null;
  if (gitDir === null) return [...paths];
  paths.add(gitDir);
  const commonDir = (await pointedDirectory(join(gitDir, "commondir"), gitDir, "")) ?? gitDir;
  paths.add(commonDir);
  const objects = await realDirectoryOrNull(join(commonDir, "objects"));
  if (objects !== null) paths.add(objects);
  return [...paths];
}

export async function homeBounds(homePath: string): Promise<GitHomeBounds> {
  const realHome = await realDirectory(homePath);
  return { realHome, homeGitPaths: await resolveHomeGitPaths(realHome) };
}

function isAllowed(bounds: GitHomeBounds, real: string): boolean {
  if (!isStrictlyInside(bounds.realHome, real)) return false;
  return bounds.homeGitPaths.every((own) => real !== own && !isStrictlyInside(own, real));
}

/** The real path of a git-reported directory, refused unless it is allowed. */
async function allowedDirectory(bounds: GitHomeBounds, path: string): Promise<string> {
  const real = await realDirectory(path);
  if (!isAllowed(bounds, real)) refuse();
  return real;
}

function hasCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

/**
 * A repository file's text (at most maxBytes), or null when there is none.
 * Opened non-blocking and checked to be a regular file before any read, so a
 * FIFO, socket or device in its place is refused instead of stalling the open.
 */
async function readRegularFile(path: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, READ_NONBLOCKING);
  } catch (err: unknown) {
    if (hasCode(err, "ENOENT")) return null;
    if (isMissingPathError(err) || hasCode(err, "EISDIR") || hasCode(err, "ENXIO")) refuse(err);
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) refuse();
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) refuse();
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Every alternate object directory (git's `objects/info/alternates`, followed
 * recursively) must be allowed too, or an object store outside home could
 * stand in for the checkout's history. Quoted entries are refused, and so is
 * an entry whose `..` leads somewhere else when taken through a symlink (as
 * newer git does) than when normalized away first (as older git does).
 */
async function assertAlternatesAllowed(bounds: GitHomeBounds, objectsDir: string): Promise<void> {
  const pending: Array<{ objectsDir: string; depth: number }> = [{ objectsDir, depth: 0 }];
  let checked = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const text = await readRegularFile(join(next.objectsDir, "info", "alternates"), ALTERNATES_MAX_BYTES);
    if (text === null) continue;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (line.startsWith("\"") || next.depth >= ALTERNATES_MAX_DEPTH || ++checked > ALTERNATES_MAX_ENTRIES) refuse();
      const lexical = await allowedDirectory(bounds, resolve(next.objectsDir, line));
      const physical = await allowedDirectory(bounds, isAbsolute(line) ? line : `${next.objectsDir}/${line}`);
      if (physical !== lexical) refuse();
      pending.push({ objectsDir: physical, depth: next.depth + 1 });
    }
  }
}

/**
 * The checkout's git directories, as git reports them, and the objects
 * directory git reads its history from must stay inside home and outside
 * home's own history.
 */
export async function assertGitDirectoriesAllowed(
  bounds: GitHomeBounds,
  dirs: { readonly gitDir: string; readonly commonDir: string },
): Promise<void> {
  await allowedDirectory(bounds, dirs.gitDir);
  const commonDir = await allowedDirectory(bounds, dirs.commonDir);
  const objectsDir = await allowedDirectory(bounds, join(commonDir, "objects"));
  await assertAlternatesAllowed(bounds, objectsDir);
}
