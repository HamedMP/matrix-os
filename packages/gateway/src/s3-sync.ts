import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";

export interface S3SyncConfig {
  homePath: string;
  bucket: string;
  prefix: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  debounceMs?: number;
  reconcileIntervalMs?: number;
  maxConcurrentUploads?: number;
}

export interface S3FileVersion {
  versionId: string;
  lastModified: Date;
  size: number;
  isLatest: boolean;
}

export interface ReconcileStats {
  filesChecked: number;
  uploadsNeeded: number;
}

export interface S3SyncDaemon {
  start(): void;
  stop(): void;
  syncFile(relativePath: string): Promise<void>;
  fullSync(): Promise<void>;
  restore(): Promise<void>;
  reconcile(): Promise<ReconcileStats>;
  onFileChange(relativePath: string): void;
  listVersions(relativePath: string): Promise<S3FileVersion[]>;
  restoreVersion(relativePath: string, versionId: string): Promise<void>;
}

export function parseSyncignore(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function shouldIgnore(relativePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      const dirName = pattern.slice(0, -1);
      if (relativePath.startsWith(dirName + "/") || relativePath === dirName) {
        return true;
      }
    } else if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (relativePath.endsWith(ext)) {
        return true;
      }
    } else if (relativePath === pattern || relativePath.startsWith(pattern + "/")) {
      return true;
    }
  }
  return false;
}

function walkDir(dir: string, base: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(base, fullPath);

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results;
}

function loadSyncignorePatterns(homePath: string): string[] {
  const ignorePath = join(homePath, ".syncignore");
  if (!existsSync(ignorePath)) {
    return [];
  }
  return parseSyncignore(readFileSync(ignorePath, "utf-8"));
}

export function createS3SyncDaemon(config: S3SyncConfig): S3SyncDaemon {
  const {
    homePath,
    bucket,
    prefix,
    debounceMs = 2000,
    reconcileIntervalMs = 300_000,
    maxConcurrentUploads = 10,
  } = config;

  const s3 = new S3Client({
    region: config.region ?? "us-east-1",
    credentials: config.accessKeyId
      ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey ?? "" }
      : undefined,
  });

  const pendingUploads = new Map<string, ReturnType<typeof setTimeout>>();
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let activeUploads = 0;
  const uploadQueue: string[] = [];

  function s3Key(relativePath: string): string {
    return `${prefix}/${relativePath}`;
  }

  async function uploadWithRetry(relativePath: string, retries = 3): Promise<void> {
    const fullPath = join(homePath, relativePath);
    if (!existsSync(fullPath)) return;

    const body = readFileSync(fullPath);

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key(relativePath),
            Body: body,
          }),
        );
        return;
      } catch (err) {
        if (attempt === retries - 1) throw err;
      }
    }
  }

  async function processUploadQueue(): Promise<void> {
    while (uploadQueue.length > 0 && activeUploads < maxConcurrentUploads) {
      const path = uploadQueue.shift();
      if (!path) break;

      activeUploads++;
      uploadWithRetry(path)
        .catch((err: unknown) => {
          console.warn("[s3-sync] Queued upload failed:", err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          activeUploads--;
          processUploadQueue();
        });
    }
  }

  function scheduleUpload(relativePath: string): void {
    const existing = pendingUploads.get(relativePath);
    if (existing) clearTimeout(existing);

    pendingUploads.set(
      relativePath,
      setTimeout(() => {
        pendingUploads.delete(relativePath);
        uploadQueue.push(relativePath);
        processUploadQueue();
      }, debounceMs),
    );
  }

  async function syncFile(relativePath: string): Promise<void> {
    await uploadWithRetry(relativePath);
  }

  async function fullSync(): Promise<void> {
    const patterns = loadSyncignorePatterns(homePath);
    const files = walkDir(homePath, homePath);

    const filtered = files.filter((f) => !shouldIgnore(f, patterns));
    for (const file of filtered) {
      await uploadWithRetry(file);
    }
  }

  async function restore(): Promise<void> {
    let continuationToken: string | undefined;

    do {
      const listResult = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: continuationToken,
        }),
      );

      const contents = listResult.Contents ?? [];

      for (const obj of contents) {
        if (!obj.Key) continue;
        const relativePath = obj.Key.slice(prefix.length + 1);
        if (!relativePath) continue;

        const getResult = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: obj.Key,
          }),
        );

        const body = getResult.Body;
        if (!body || typeof (body as { transformToByteArray?: unknown }).transformToByteArray !== "function") continue;

        const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
        const fullPath = join(homePath, relativePath);
        const dir = dirname(fullPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await writeFile(fullPath, Buffer.from(bytes));
      }

      continuationToken = listResult.IsTruncated
        ? listResult.NextContinuationToken
        : undefined;
    } while (continuationToken);
  }

  async function reconcile(): Promise<ReconcileStats> {
    const patterns = loadSyncignorePatterns(homePath);
    const localFiles = walkDir(homePath, homePath).filter((f) => !shouldIgnore(f, patterns));

    const s3Keys = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const listResult = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of listResult.Contents ?? []) {
        if (obj.Key) {
          s3Keys.add(obj.Key.slice(prefix.length + 1));
        }
      }

      continuationToken = listResult.IsTruncated
        ? listResult.NextContinuationToken
        : undefined;
    } while (continuationToken);

    const missing = localFiles.filter((f) => !s3Keys.has(f));

    for (const file of missing) {
      await uploadWithRetry(file).catch((err: unknown) => {
        console.warn("[s3-sync] Reconcile upload failed:", err instanceof Error ? err.message : String(err));
      });
    }

    return {
      filesChecked: localFiles.length,
      uploadsNeeded: missing.length,
    };
  }

  async function listVersions(relativePath: string): Promise<S3FileVersion[]> {
    const result = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: s3Key(relativePath),
      }),
    );

    return (result.Versions ?? []).map((v) => ({
      versionId: v.VersionId ?? "",
      lastModified: v.LastModified ?? new Date(),
      size: v.Size ?? 0,
      isLatest: v.IsLatest ?? false,
    }));
  }

  async function restoreVersion(relativePath: string, versionId: string): Promise<void> {
    const getResult = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key(relativePath),
        VersionId: versionId,
      }),
    );

    const body = getResult.Body;
    if (!body || typeof (body as { transformToByteArray?: unknown }).transformToByteArray !== "function") return;

    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    const fullPath = join(homePath, relativePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await writeFile(fullPath, Buffer.from(bytes));
  }

  function onFileChange(relativePath: string): void {
    const patterns = loadSyncignorePatterns(homePath);
    if (shouldIgnore(relativePath, patterns)) return;
    scheduleUpload(relativePath);
  }

  return {
    start() {
      reconcileTimer = setInterval(() => {
        reconcile().catch((err: unknown) => {
          console.warn("[s3-sync] Scheduled reconcile failed:", err instanceof Error ? err.message : String(err));
        });
      }, reconcileIntervalMs);
    },
    stop() {
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
      for (const timer of pendingUploads.values()) {
        clearTimeout(timer);
      }
      pendingUploads.clear();
    },
    syncFile,
    fullSync,
    restore,
    reconcile,
    onFileChange,
    listVersions,
    restoreVersion,
  };
}
