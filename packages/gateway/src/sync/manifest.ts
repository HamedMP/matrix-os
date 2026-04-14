import { ManifestSchema, type Manifest, type CommitFile } from "./types.js";
import { buildManifestKey } from "./r2-client.js";
import type { R2Client } from "./r2-client.js";

const MANIFEST_FILE_CAP = 50_000;

export interface ManifestMeta {
  version: number;
  file_count: number;
  total_size: bigint;
  etag: string | null;
  updated_at: Date;
}

export interface ManifestDb {
  getManifestMeta(userId: string): Promise<ManifestMeta | null>;
  upsertManifestMeta(userId: string, meta: Omit<ManifestMeta, "updated_at">): Promise<void>;
  withAdvisoryLock<T>(userId: string, fn: () => Promise<T>): Promise<T>;
}

export interface ManifestStore {
  r2: R2Client;
  db: ManifestDb;
}

export interface ReadManifestResult {
  manifest: Manifest;
  manifestVersion: number;
  etag: string;
}

const EMPTY_MANIFEST: Manifest = { version: 2, files: {} };

export async function readManifest(
  store: ManifestStore,
  userId: string,
): Promise<ReadManifestResult> {
  const meta = await store.db.getManifestMeta(userId);
  const key = buildManifestKey(userId);

  let manifest: Manifest;
  let etag = "";

  try {
    const result = await store.r2.getObject(key);
    if (result.body) {
      const text = await (result.body as any).text();
      manifest = ManifestSchema.parse(JSON.parse(text));
    } else {
      manifest = { ...EMPTY_MANIFEST, files: {} };
    }
    etag = result.etag ?? "";
  } catch (err: unknown) {
    if (err instanceof Error && (err.name === "NoSuchKey" || err.message.includes("NoSuchKey"))) {
      manifest = { ...EMPTY_MANIFEST, files: {} };
    } else {
      throw err;
    }
  }

  return {
    manifest,
    manifestVersion: meta?.version ?? 0,
    etag,
  };
}

export async function writeManifest(
  store: ManifestStore,
  userId: string,
  manifest: Manifest,
  newVersion: number,
): Promise<void> {
  const key = buildManifestKey(userId);
  const body = JSON.stringify(manifest);
  const result = await store.r2.putObject(key, body);

  const liveFiles = Object.values(manifest.files).filter((e) => !e.deleted);
  const fileCount = liveFiles.length;
  const totalSize = liveFiles.reduce((sum, e) => sum + BigInt(e.size), 0n);

  await store.db.upsertManifestMeta(userId, {
    version: newVersion,
    file_count: fileCount,
    total_size: totalSize,
    etag: result.etag ?? null,
  });
}

export function applyCommitToManifest(
  manifest: Manifest,
  files: CommitFile[],
  peerId: string,
): Manifest {
  const updated: Manifest = {
    version: 2,
    files: { ...manifest.files },
  };

  for (const file of files) {
    const existing = updated.files[file.path];
    const currentVersion = existing?.version ?? 0;

    if (file.action === "delete") {
      updated.files[file.path] = {
        hash: file.hash,
        size: 0,
        mtime: Date.now(),
        peerId,
        version: currentVersion + 1,
        deleted: true,
        deletedAt: Date.now(),
      };
    } else {
      updated.files[file.path] = {
        hash: file.hash,
        size: file.size,
        mtime: Date.now(),
        peerId,
        version: currentVersion + 1,
      };
    }
  }

  // Enforce 50K file cap (counting non-tombstoned files only)
  const liveCount = Object.values(updated.files).filter((e) => !e.deleted).length;
  if (liveCount > MANIFEST_FILE_CAP) {
    throw new Error(`Manifest file cap exceeded: ${liveCount} live files (max ${MANIFEST_FILE_CAP.toLocaleString()})`);
  }

  return updated;
}

const DEFAULT_TOMBSTONE_MAX_AGE_DAYS = 30;

export function garbageCollectTombstones(
  manifest: Manifest,
  maxAgeDays = DEFAULT_TOMBSTONE_MAX_AGE_DAYS,
): Manifest & { collected: number } {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files: Manifest["files"] = {};
  let collected = 0;

  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.deleted) {
      const deletedAt = entry.deletedAt ?? 0;
      if (deletedAt < cutoff) {
        collected++;
        continue;
      }
    }
    files[path] = entry;
  }

  return { version: 2, files, collected };
}
