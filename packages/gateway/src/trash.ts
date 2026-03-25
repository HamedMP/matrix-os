import {
  stat as fsStat,
  mkdir,
  rename,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { resolveWithinHome } from "./path-security.js";

interface TrashManifestEntry {
  name: string;
  originalPath: string;
  deletedAt: string;
  trashPath: string;
}

interface TrashListEntry {
  name: string;
  originalPath: string;
  deletedAt: string;
  trashPath: string;
  size?: number;
  type: "file" | "directory";
}

const mutexes = new Map<string, Promise<unknown>>();

function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(key) ?? Promise.resolve();
  const next = prev
    .then(() => fn(), () => fn())
    .finally(() => {
      if (mutexes.get(key) === next) mutexes.delete(key);
    }) as Promise<T>;
  mutexes.set(key, next);
  return next;
}

async function readManifest(trashDir: string): Promise<TrashManifestEntry[]> {
  const manifestPath = join(trashDir, ".manifest.json");
  try {
    const data = await readFile(manifestPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeManifest(
  trashDir: string,
  manifest: TrashManifestEntry[],
): Promise<void> {
  const manifestPath = join(trashDir, ".manifest.json");
  const tmpPath = manifestPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(manifest, null, 2));
  await rename(tmpPath, manifestPath);
}

export async function fileDelete(
  homePath: string,
  requestedPath: string,
): Promise<{ ok: boolean; trashPath?: string; error?: string; status?: number }> {
  const resolved = resolveWithinHome(homePath, requestedPath);
  if (!resolved) return { ok: false, error: "Invalid path" };

  if (!existsSync(resolved)) {
    return { ok: false, error: "Not found", status: 404 };
  }

  const trashDir = join(homePath, ".trash");

  return withMutex(trashDir, async () => {
    await mkdir(trashDir, { recursive: true });

    const name = basename(resolved);
    let trashName = name;

    if (existsSync(join(trashDir, trashName))) {
      trashName = `${Date.now()}-${name}`;
    }

    const trashFullPath = join(trashDir, trashName);
    await rename(resolved, trashFullPath);

    const manifest = await readManifest(trashDir);
    manifest.push({
      name,
      originalPath: requestedPath,
      deletedAt: new Date().toISOString(),
      trashPath: `.trash/${trashName}`,
    });
    await writeManifest(trashDir, manifest);

    return { ok: true, trashPath: `.trash/${trashName}` };
  });
}

export async function trashList(
  homePath: string,
): Promise<{ entries: TrashListEntry[] }> {
  const trashDir = join(homePath, ".trash");
  const manifest = await readManifest(trashDir);

  const trashBase = join(homePath, ".trash");
  const entries: TrashListEntry[] = [];
  for (const entry of manifest) {
    const fullPath = join(homePath, entry.trashPath);
    if (!fullPath.startsWith(trashBase + "/")) continue;
    try {
      const stats = await fsStat(fullPath);
      entries.push({
        name: entry.name,
        originalPath: entry.originalPath,
        deletedAt: entry.deletedAt,
        trashPath: entry.trashPath,
        size: stats.isFile() ? stats.size : undefined,
        type: stats.isDirectory() ? "directory" : "file",
      });
    } catch {
      // skip entries whose files were manually removed
    }
  }

  return { entries };
}

export async function trashRestore(
  homePath: string,
  trashPath: string,
): Promise<{ ok: boolean; restoredTo?: string; error?: string; status?: number }> {
  const trashDir = join(homePath, ".trash");
  const resolvedTrash = resolveWithinHome(homePath, trashPath);
  const trashBase = join(homePath, ".trash");
  if (!resolvedTrash || (!resolvedTrash.startsWith(trashBase + "/") && resolvedTrash !== trashBase)) {
    return { ok: false, error: "Invalid trash path" };
  }

  if (!existsSync(resolvedTrash)) {
    return { ok: false, error: "Not found in trash", status: 404 };
  }

  return withMutex(trashDir, async () => {
    const manifest = await readManifest(trashDir);
    const entryIndex = manifest.findIndex((e) => e.trashPath === trashPath);
    if (entryIndex === -1) {
      return { ok: false, error: "Not found in trash", status: 404 };
    }

    const entry = manifest[entryIndex];
    const resolvedRestore = resolveWithinHome(homePath, entry.originalPath);
    if (!resolvedRestore) {
      return { ok: false, error: "Invalid restore path" };
    }
    const restorePath = resolvedRestore;

    if (existsSync(restorePath)) {
      return { ok: false, error: "Destination already exists", status: 409 };
    }

    // Ensure parent directory exists
    const parentDir = join(restorePath, "..");
    await mkdir(parentDir, { recursive: true });

    await rename(resolvedTrash, restorePath);

    manifest.splice(entryIndex, 1);
    await writeManifest(trashDir, manifest);

    return { ok: true, restoredTo: entry.originalPath };
  });
}

export async function trashEmpty(
  homePath: string,
): Promise<{ ok: boolean; deleted: number }> {
  const trashDir = join(homePath, ".trash");

  return withMutex(trashDir, async () => {
    const manifest = await readManifest(trashDir);
    const count = manifest.length;

    if (count === 0) return { ok: true, deleted: 0 };

    // Delete all files in trash
    try {
      const entries = await readdir(trashDir);
      for (const entry of entries) {
        if (entry === ".manifest.json" || entry === ".manifest.json.tmp")
          continue;
        await rm(join(trashDir, entry), { recursive: true, force: true });
      }
    } catch {
      // trash dir may not exist
    }

    // Clear manifest
    await writeManifest(trashDir, []);

    return { ok: true, deleted: count };
  });
}
