import type { Kysely, Transaction } from "kysely";
import { ManifestSchema, type Manifest, type CommitFile } from "./types.js";
import { buildManifestKey } from "./r2-client.js";
import type { R2Client } from "./r2-client.js";
import type { SyncDatabase } from "./sharing-db.js";

const MANIFEST_FILE_CAP = 50_000;

export class ManifestCapExceededError extends Error {
  constructor(
    readonly liveCount: number,
    readonly cap: number = MANIFEST_FILE_CAP,
  ) {
    super(
      `Manifest file cap exceeded: ${liveCount} live files (max ${cap.toLocaleString()})`,
    );
    this.name = "ManifestCapExceededError";
  }
}

export interface ManifestMeta {
  version: number;
  file_count: number;
  total_size: bigint;
  etag: string | null;
  updated_at: Date;
}

export type ManifestDbExecutor = Kysely<SyncDatabase> | Transaction<SyncDatabase>;

export interface ManifestDb {
  getManifestMeta(
    userId: string,
    executor?: ManifestDbExecutor,
  ): Promise<ManifestMeta | null>;
  getAggregateManifestStats?(): Promise<{ fileCount: number; totalSize: bigint }>;
  upsertManifestMeta(
    userId: string,
    meta: Omit<ManifestMeta, "updated_at">,
    executor?: ManifestDbExecutor,
  ): Promise<void>;
  withAdvisoryLock<T>(
    userId: string,
    fn: (executor: ManifestDbExecutor) => Promise<T>,
  ): Promise<T>;
}

export interface ManifestStore {
  r2: R2Client;
  db: ManifestDb;
  dbExecutor?: ManifestDbExecutor;
}

export interface ReadManifestResult {
  manifest: Manifest;
  manifestVersion: number;
  etag: string;
}

async function readObjectBodyAsText(body: unknown): Promise<string> {
  const anyBody = body as {
    transformToString?: () => Promise<string>;
    text?: () => Promise<string>;
    transformToByteArray?: () => Promise<Uint8Array>;
  };
  if (typeof anyBody.transformToString === "function") {
    return anyBody.transformToString();
  }
  if (typeof anyBody.text === "function") {
    return anyBody.text();
  }
  if (typeof anyBody.transformToByteArray === "function") {
    return Buffer.from(await anyBody.transformToByteArray()).toString("utf-8");
  }
  throw new Error("Unsupported R2 object body type");
}

const EMPTY_MANIFEST: Manifest = { version: 2, files: {} };

function liveManifestStats(manifest: Manifest): { fileCount: number; totalSize: bigint } {
  const liveFiles = Object.values(manifest.files).filter((e) => !e.deleted);
  return {
    fileCount: liveFiles.length,
    totalSize: liveFiles.reduce((sum, e) => sum + BigInt(e.size), 0n),
  };
}

export async function readManifest(
  store: ManifestStore,
  userId: string,
): Promise<ReadManifestResult> {
  const meta = await store.db.getManifestMeta(userId, store.dbExecutor);
  const key = buildManifestKey(userId);

  let manifest: Manifest;
  let etag = "";
  let storedManifestVersion = 0;

  try {
    const result = await store.r2.getObject(key);
    if (result.body) {
      const text = await readObjectBodyAsText(result.body);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (
        typeof parsed.manifestVersion === "number" &&
        Number.isInteger(parsed.manifestVersion) &&
        parsed.manifestVersion >= 0
      ) {
        storedManifestVersion = parsed.manifestVersion;
      }
      manifest = ManifestSchema.parse(parsed);
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

  const manifestVersion = Math.max(meta?.version ?? 0, storedManifestVersion);
  if (manifestVersion > (meta?.version ?? 0)) {
    const stats = liveManifestStats(manifest);
    await store.db.upsertManifestMeta(userId, {
      version: manifestVersion,
      file_count: stats.fileCount,
      total_size: stats.totalSize,
      etag: etag || null,
    }, store.dbExecutor);
  }

  return {
    manifest,
    manifestVersion,
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
  const { fileCount, totalSize } = liveManifestStats(manifest);
  const body = JSON.stringify({
    ...manifest,
    manifestVersion: newVersion,
  });

  await store.db.upsertManifestMeta(userId, {
    version: newVersion,
    file_count: fileCount,
    total_size: totalSize,
    etag: null,
  }, store.dbExecutor);

  // DB metadata remains the source of truth for fast reads, but readManifest()
  // reconciles split-brain by taking Math.max(db.version, manifestVersion) and
  // repairing the DB metadata if an R2 write succeeds before the DB commit does.
  await store.r2.putObject(key, body);
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
    throw new ManifestCapExceededError(liveCount);
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
