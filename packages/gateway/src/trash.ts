import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { restoreWithoutReplacing } from "./trash-restore.js";
import { withOwnerFileMutation } from "./owner-file-mutations.js";
import {
  isDeniedFileApiMutationPath,
  isProtectedHomeSubpath,
  resolveWithinHome,
  resolveWritableFileApiPath,
} from "./path-security.js";

const MANIFEST_NAME = ".manifest.json";
const STAGING_NAME = ".manifest.json.tmp";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 10_000;

function isStoredTrashPath(path: string): boolean {
  if (!path.startsWith(".trash/")) return false;
  const name = path.slice(".trash/".length);
  return name !== "" && ![".", "..", MANIFEST_NAME, STAGING_NAME].includes(name)
    && !name.includes("/") && !name.includes("\0")
    && (process.platform !== "win32" || !name.includes("\\"));
}

const TrashManifestSchema = z.array(z.object({
  name: z.string().min(1).max(4096),
  originalPath: z.string().min(1).max(4096),
  deletedAt: z.string().min(1).max(128),
  trashPath: z.string().max(4096).refine(isStoredTrashPath),
})).max(MAX_MANIFEST_ENTRIES);
type TrashManifestEntry = z.infer<typeof TrashManifestSchema>[number];

interface TrashListEntry extends TrashManifestEntry {
  size?: number;
  type: "file" | "directory";
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function statIfPresent(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readManifest(trashDir: string): Promise<TrashManifestEntry[]> {
  const directory = await statIfPresent(trashDir);
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error("Trash directory unavailable");
  let file;
  try {
    file = await open(join(trashDir, MANIFEST_NAME), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error("Trash index unavailable");
    const contents = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < contents.length) {
      const { bytesRead } = await file.read(contents, count, contents.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count !== info.size) throw new Error("Trash index changed");
    return TrashManifestSchema.parse(JSON.parse(contents.toString("utf8", 0, count)));
  } finally {
    await file.close();
  }
}

async function writeManifest(trashDir: string, manifest: TrashManifestEntry[]): Promise<void> {
  const data = JSON.stringify(manifest, null, 2);
  if (manifest.length > MAX_MANIFEST_ENTRIES || Buffer.byteLength(data) > MAX_MANIFEST_BYTES) {
    throw new Error("Trash index is full");
  }
  const tmpPath = join(trashDir, STAGING_NAME);
  const stale = await statIfPresent(tmpPath);
  if (stale) {
    // A process exit may leave the single reserved staging file behind.
    if (!stale.isFile()) throw new Error("Trash staging unavailable");
    await unlink(tmpPath);
  }
  const staging = await open(tmpPath, "wx", 0o600);
  try {
    await staging.writeFile(data, "utf8");
    await staging.sync();
  } finally {
    await staging.close();
  }
  await rename(tmpPath, join(trashDir, MANIFEST_NAME));
}

const LEGACY_RESTORE_PROTECTED_PATHS = ["system/config.json", "system/matrix.db", "system/soul.md", "agents"];

function unavailable(operation: string, error: unknown) {
  console.warn(`[trash] ${operation} failed:`, error instanceof Error ? error.name : "UnknownError");
  return { ok: false as const, error: "Trash is unavailable", status: 503 };
}

export async function fileDelete(
  homePath: string,
  requestedPath: string,
): Promise<{ ok: boolean; trashPath?: string; error?: string; status?: number }> {
  const lexicalPath = resolveWithinHome(homePath, requestedPath);
  if (!lexicalPath) return { ok: false, error: "Invalid path" };
  if (isProtectedHomeSubpath(homePath, lexicalPath)) {
    return { ok: false, error: "Protected path cannot be deleted", status: 403 };
  }
  if (isDeniedFileApiMutationPath(homePath, requestedPath)) return { ok: false, error: "Invalid path" };

  const trashDir = join(homePath, ".trash");
  try {
    return await withOwnerFileMutation(trashDir, async () => {
      const resolved = resolveWritableFileApiPath(homePath, requestedPath);
      if (!resolved) return { ok: false, error: "Invalid path" };
      const info = await statIfPresent(resolved);
      if (!info) return { ok: false, error: "Not found", status: 404 };
      if (!info.isFile() && !info.isDirectory()) return { ok: false, error: "Invalid path" };
      await mkdir(trashDir, { recursive: true, mode: 0o700 });

      const name = basename(resolved);
      const entries = await trashList(homePath);
      const manifest = entries.entries.map(({ type: _type, size: _size, ...entry }) => entry);
      // Never reuse restore tokens, even if the same source is moved again.
      const trashPath = `.trash/${randomUUID()}`;
      const entry = { name, originalPath: relative(homePath, resolved), deletedAt: new Date().toISOString(), trashPath };
      // Recovery is recorded first. A stopped operation with no destination
      // file leaves an invisible reservation that the next mutation drops.
      await writeManifest(trashDir, [...manifest, entry]);
      const liveSource = await statIfPresent(resolved);
      if (liveSource?.ino !== info.ino || liveSource.dev !== info.dev
        || resolveWritableFileApiPath(homePath, requestedPath) !== resolved) {
        return { ok: false, error: "Source changed", status: 409 };
      }
      await rename(resolved, join(homePath, trashPath));
      return { ok: true, trashPath };
    });
  } catch (error) {
    return unavailable("Move to Trash", error);
  }
}

export async function trashList(homePath: string): Promise<{ entries: TrashListEntry[] }> {
  const manifest = await readManifest(join(homePath, ".trash"));
  const entries: TrashListEntry[] = [];
  for (const entry of manifest) {
    const stats = await statIfPresent(join(homePath, entry.trashPath));
    if (stats?.isDirectory()) entries.push({ ...entry, type: "directory" });
    if (stats?.isFile()) entries.push({ ...entry, size: stats.size, type: "file" });
  }
  return { entries };
}

export async function trashRestore(
  homePath: string,
  trashPath: string,
): Promise<{ ok: boolean; restoredTo?: string; error?: string; status?: number }> {
  const normalized = trashPath.replace(/^\/+/, "");
  if (!isStoredTrashPath(normalized)) return { ok: false, error: "Invalid trash path" };
  const trashDir = join(homePath, ".trash");

  try {
    return await withOwnerFileMutation(trashDir, async () => {
      const manifest = await readManifest(trashDir);
      const entry = manifest.find((item) => item.trashPath === normalized);
      const source = join(homePath, normalized);
      const sourceInfo = entry && await statIfPresent(source);
      if (!entry || (!sourceInfo?.isFile() && !sourceInfo?.isDirectory())) {
        return { ok: false, error: "Not found in trash", status: 404 };
      }

      const lexicalPath = resolveWithinHome(homePath, entry.originalPath);
      const originalPath = lexicalPath && relative(homePath, lexicalPath);
      if (!originalPath || isDeniedFileApiMutationPath(homePath, entry.originalPath) || originalPath.startsWith(".trash/")
        || originalPath === ".trash" || LEGACY_RESTORE_PROTECTED_PATHS.some((path) => originalPath === path || originalPath.startsWith(`${path}/`))) {
        return { ok: false, error: "Cannot restore to a protected path", status: 403 };
      }
      const restorePath = resolveWritableFileApiPath(homePath, entry.originalPath);
      if (!restorePath) {
        // A regular or dangling link in the destination slot is a conflict.
        if ((await statIfPresent(lexicalPath))?.isSymbolicLink()) {
          return { ok: false, error: "Destination already exists", status: 409 };
        }
        return { ok: false, error: "Invalid restore path" };
      }
      if (await statIfPresent(restorePath)
        || !await restoreWithoutReplacing(resolve(homePath), basename(source), originalPath)) {
        return { ok: false, error: "Destination already exists", status: 409 };
      }
      try {
        await writeManifest(trashDir, manifest.filter((item) => item.trashPath !== normalized));
      } catch (error) {
        // The file was restored. A stale row without a file is invisible.
        unavailable("Restore index cleanup", error);
      }
      return { ok: true, restoredTo: entry.originalPath };
    });
  } catch (error) {
    return unavailable("Restore", error);
  }
}

export async function trashEmpty(homePath: string): Promise<{ ok: boolean; deleted: number }> {
  const trashDir = join(homePath, ".trash");
  return withOwnerFileMutation(trashDir, async () => {
    const manifest = await readManifest(trashDir);
    if (manifest.length === 0) return { ok: true, deleted: 0 };
    let deleted = 0;
    const remaining: TrashManifestEntry[] = [];
    for (const entry of manifest) {
      try {
        const file = join(homePath, entry.trashPath);
        if (!await statIfPresent(file)) continue;
        await rm(file, { recursive: true, force: true });
        deleted++;
      } catch (error) {
        unavailable("Empty Trash", error);
        remaining.push(entry);
      }
    }
    await writeManifest(trashDir, remaining);
    return { ok: remaining.length === 0, deleted };
  });
}
