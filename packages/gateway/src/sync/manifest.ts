import type { Kysely, Transaction } from "kysely";
import { createHash } from "node:crypto";
import type { SyncScope } from "@matrix-os/contracts";
import { ManifestSchema, type Manifest, type CommitFile } from "./types.js";
import { buildManifestGenerationKey, buildManifestKey } from "./r2-client.js";
import type { R2Client } from "./r2-client.js";
import type { SyncDatabase } from "./sharing-db.js";

const MANIFEST_FILE_CAP = 50_000;
export const MANIFEST_JSON_MAX_BYTES = 32 * 1024 * 1024;

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

export class ManifestTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number = MANIFEST_JSON_MAX_BYTES,
  ) {
    super(
      `Manifest JSON exceeds ${maxBytes.toLocaleString()} bytes (received ${sizeBytes.toLocaleString()})`,
    );
    this.name = "ManifestTooLargeError";
  }
}

export class AcceptedManifestMissingError extends Error {
  constructor(readonly acceptedVersion: number) {
    super("Accepted sync manifest is unavailable");
    this.name = "AcceptedManifestMissingError";
  }
}

export class ManifestVersionMismatchError extends Error {
  constructor(
    readonly acceptedVersion: number,
    readonly storedVersion: number,
  ) {
    super("Stored sync manifest does not match the accepted revision");
    this.name = "ManifestVersionMismatchError";
  }
}

export class ManifestAdvanceConflictError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly attemptedVersion: number,
  ) {
    super("Accepted sync manifest changed during publication");
    this.name = "ManifestAdvanceConflictError";
  }
}

export interface ManifestMeta {
  version: number;
  file_count: number;
  total_size: bigint;
  etag: string | null;
  accepted_manifest_key?: string | null;
  updated_at: Date;
}

export type ManifestDbExecutor = Kysely<SyncDatabase> | Transaction<SyncDatabase>;
export type ManifestScope = string | SyncScope;

export function normalizeManifestScope(scope: ManifestScope): SyncScope {
  return typeof scope === "string"
    ? { ownerId: scope, runtimeSlot: "primary" }
    : scope;
}

export interface ManifestDb {
  getManifestMeta(
    scope: ManifestScope,
    executor?: ManifestDbExecutor,
  ): Promise<ManifestMeta | null>;
  getAggregateManifestStats?(): Promise<{ fileCount: number; totalSize: bigint }>;
  upsertManifestMeta(
    scope: ManifestScope,
    meta: Omit<ManifestMeta, "updated_at">,
    executor?: ManifestDbExecutor,
  ): Promise<void>;
  advanceManifestMeta(
    scope: ManifestScope,
    expectedVersion: number,
    meta: Omit<ManifestMeta, "updated_at">,
    executor?: ManifestDbExecutor,
  ): Promise<boolean>;
  withAdvisoryLock<T>(
    scope: ManifestScope,
    fn: (executor: ManifestDbExecutor) => Promise<T>,
  ): Promise<T>;
}

export interface ManifestStore {
  signal?: AbortSignal;
  r2: R2Client;
  db: ManifestDb;
  dbExecutor?: ManifestDbExecutor;
}

export interface ReadManifestResult {
  manifest: Manifest;
  manifestVersion: number;
  etag: string;
}

function ensureManifestSize(sizeBytes: number, maxBytes = MANIFEST_JSON_MAX_BYTES): void {
  if (sizeBytes > maxBytes) {
    throw new ManifestTooLargeError(sizeBytes, maxBytes);
  }
}

async function readObjectBodyAsText(
  body: unknown,
  maxBytes = MANIFEST_JSON_MAX_BYTES,
): Promise<string> {
  const anyBody = body as {
    transformToString?: () => Promise<string>;
    text?: () => Promise<string>;
    transformToByteArray?: () => Promise<Uint8Array>;
  };
  if (typeof anyBody.transformToByteArray === "function") {
    const bytes = await anyBody.transformToByteArray();
    ensureManifestSize(bytes.byteLength, maxBytes);
    return Buffer.from(bytes).toString("utf-8");
  }
  if (typeof anyBody.transformToString === "function") {
    const text = await anyBody.transformToString();
    ensureManifestSize(Buffer.byteLength(text, "utf-8"), maxBytes);
    return text;
  }
  if (typeof anyBody.text === "function") {
    const text = await anyBody.text();
    ensureManifestSize(Buffer.byteLength(text, "utf-8"), maxBytes);
    return text;
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
  scope: ManifestScope,
): Promise<ReadManifestResult> {
  const meta = await store.db.getManifestMeta(scope, store.dbExecutor);
  const key = meta?.accepted_manifest_key ?? buildManifestKey(scope);
  const hasAcceptedPointer = Boolean(meta?.accepted_manifest_key);

  let manifest: Manifest;
  let etag = "";
  let storedManifestVersion = 0;
  let objectFound = false;

  try {
    const result = await store.r2.getObject(key, ...(store.signal ? [{ signal: store.signal }] : []));
    if (result.body) {
      objectFound = true;
      if (typeof result.contentLength === "number") {
        ensureManifestSize(result.contentLength);
      }
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

  const acceptedVersion = meta?.version ?? 0;
  if ((hasAcceptedPointer || acceptedVersion > 0) && !objectFound) {
    throw new AcceptedManifestMissingError(acceptedVersion);
  }
  if (hasAcceptedPointer && objectFound && storedManifestVersion !== acceptedVersion) {
    throw new ManifestVersionMismatchError(acceptedVersion, storedManifestVersion);
  }

  if (!hasAcceptedPointer && storedManifestVersion > acceptedVersion) {
    const stats = liveManifestStats(manifest);
    await store.db.upsertManifestMeta(scope, {
      version: storedManifestVersion,
      file_count: stats.fileCount,
      total_size: stats.totalSize,
      etag: etag || null,
      accepted_manifest_key: null,
    }, store.dbExecutor);
  }

  return {
    manifest,
    manifestVersion: hasAcceptedPointer
      ? acceptedVersion
      : Math.max(acceptedVersion, storedManifestVersion),
    etag,
  };
}

export async function writeManifest(
  store: ManifestStore,
  scope: ManifestScope,
  manifest: Manifest,
  newVersion: number,
): Promise<void> {
  const { fileCount, totalSize } = liveManifestStats(manifest);
  const body = JSON.stringify({
    ...manifest,
    manifestVersion: newVersion,
  });
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const generationKey = buildManifestGenerationKey(scope, newVersion, bodyHash);

  // The generation key is content-addressed, so retries can only replace it
  // with identical bytes. A failed metadata transaction leaves a reclaimable
  // orphan and cannot change the previously accepted generation.
  store.signal?.throwIfAborted();
  const { etag } = await store.r2.putObject(generationKey, body, ...(store.signal ? [{ signal: store.signal }] : []));
  store.signal?.throwIfAborted();

  const nextMeta = {
    version: newVersion,
    file_count: fileCount,
    total_size: totalSize,
    etag: etag ?? null,
    accepted_manifest_key: generationKey,
  };
  const expectedVersion = newVersion - 1;
  const advanced = await store.db.advanceManifestMeta(
    scope,
    expectedVersion,
    nextMeta,
    store.dbExecutor,
  );
  if (!advanced) {
    throw new ManifestAdvanceConflictError(expectedVersion, newVersion);
  }

}

export function applyCommitToManifest(
  manifest: Manifest,
  files: Array<CommitFile & { objectKey?: string }>,
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
        ...(file.objectKey ? { objectKey: file.objectKey } : {}),
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
