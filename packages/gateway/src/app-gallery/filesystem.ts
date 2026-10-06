import { constants } from "node:fs";
import { link, lstat, open, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export class GalleryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); }
}
export function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
export interface GalleryLimits { maxFileBytes: number; maxTotalBytes: number; maxFiles: number; maxEntries: number; maxCatalogBytes: number }
export const DEFAULT_LIMITS: GalleryLimits = { maxFileBytes: 4_194_304, maxTotalBytes: 25_165_824, maxFiles: 256, maxEntries: 512, maxCatalogBytes: 262_144 };

/** Reject symlinks in every component, including owner home and intermediate folders. */
export async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GalleryError(409, "Unsafe directory");
  }
}

export async function readLimited(path: string, maxBytes: number): Promise<Buffer> {
  await safeDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new GalleryError(503, "Invalid file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > maxBytes) throw new GalleryError(503, "File too large");
    return buffer.subarray(0, count);
  } finally { await handle.close(); }
}

export async function readTemplate(templatePath: string, limits: GalleryLimits): Promise<Map<string, Buffer>> {
  await safeDirectory(templatePath);
  const root = await realpath(templatePath);
  const files = new Map<string, Buffer>(); // Request-scoped, capped below, discarded on completion.
  let entries = 0, total = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 16) throw new GalleryError(503, "Template nesting limit");
    const iterator = await opendir(directory);
    for await (const entry of iterator) {
      if (++entries > limits.maxEntries) throw new GalleryError(503, "Template entry limit");
      const fullPath = join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new GalleryError(503, "Template contains symlink");
      if (info.isDirectory()) { await visit(fullPath, depth + 1); continue; }
      if (!info.isFile()) throw new GalleryError(503, "Invalid template entry");
      const key = relative(root, fullPath).split(sep).join("/");
      if (key === "matrix.json") continue; // Always generate the selected definition's manifest.
      if (files.size >= limits.maxFiles || info.size + total > limits.maxTotalBytes) throw new GalleryError(503, "Template size limit");
      const bytes = await readLimited(fullPath, Math.min(limits.maxFileBytes, limits.maxTotalBytes - total));
      total += bytes.length; files.set(key, bytes);
    }
  }
  await visit(root, 0);
  return files;
}

export interface OwnedDirectory { path: string; dev: number; ino: number }
export async function directoryIdentity(path: string): Promise<OwnedDirectory> {
  await safeDirectory(path);
  const info = await lstat(path);
  return { path, dev: info.dev, ino: info.ino };
}
export interface OwnedFile { path: string; dev: number; ino: number; digest: string; bytes: number }
export async function exclusiveWrite(path: string, bytes: Buffer): Promise<OwnedFile> {
  await safeDirectory(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let identity: { dev: number; ino: number } | undefined;
  let written = 0;
  try {
    identity = await handle.stat();
    // Track successful writes explicitly: writeFile can reject after internally writing a prefix.
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, written);
      if (result.bytesWritten === 0) throw new GalleryError(503, "File write made no progress");
      written += result.bytesWritten;
    }
    await handle.close();
    return { path, ...identity, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  } catch (error) {
    try { await handle.close(); }
    catch (closeError) { console.warn("[app-gallery] Failed to close installer file", closeError); }
    if (identity) {
      const expectedPrefix = bytes.subarray(0, written);
      await cleanOwnedFiles([{ path, ...identity, digest: createHash("sha256").update(expectedPrefix).digest("hex"), bytes: written }], []);
    }
    throw error;
  }
}

/** Publish a fully closed manifest atomically without replacing any existing owner file. */
export async function publishManifest(path: string, bytes: Buffer): Promise<void> {
  const stagingPath = join(dirname(path), `.gallery-manifest-${randomUUID()}.json`);
  const owned = await exclusiveWrite(stagingPath, bytes);
  try {
    await safeDirectory(dirname(path));
    await link(stagingPath, path); // Exclusive publication: EEXIST never overwrites owner files.
  } finally {
    await cleanOwnedFiles([owned], []); // Explicit, inode/content-checked cleanup on success and failure.
  }
}

/** Roll back only unchanged files we created; retain concurrent owner edits and nonempty folders. */
export async function cleanOwnedFiles(files: OwnedFile[], directories: OwnedDirectory[]): Promise<void> {
  for (const file of [...files].reverse()) {
    try {
      const info = await lstat(file.path);
      if (info.isSymbolicLink() || !info.isFile() || info.dev !== file.dev || info.ino !== file.ino || info.size !== file.bytes) continue;
      const bytes = await readLimited(file.path, file.bytes);
      if (createHash("sha256").update(bytes).digest("hex") === file.digest) await unlink(file.path);
    } catch (error) {
      if (!isFsError(error, "ENOENT")) console.warn("[app-gallery] Retained file during safe rollback", error);
    }
  }
  for (const directory of [...directories].reverse()) {
    try { await safeDirectory(directory.path);
      const info = await lstat(directory.path);
      if (info.dev === directory.dev && info.ino === directory.ino) await rmdir(directory.path); }
    catch (error) {
      if (!isFsError(error, "ENOENT") && !isFsError(error, "ENOTEMPTY")) console.warn("[app-gallery] Retained directory during safe rollback", error);
    }
  }
}
