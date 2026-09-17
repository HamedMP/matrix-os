import type { SyncScope } from "@matrix-os/contracts";
import { buildSyncScopePrefix } from "./runtime-scope.js";

const DEFAULT_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_LISTED_PER_KIND = 1_000;
const DEFAULT_MAX_ACTIONS = 100;
const DEFAULT_SWEEP_TIMEOUT_MS = 60_000;

export interface ListedSyncObject {
  key: string;
  lastModified?: Date;
}

export interface ListedSyncMultipartUpload {
  key: string;
  uploadId: string;
  initiated?: Date;
}

export interface SyncOrphanSweepStore {
  getAcceptedManifestKey(scope: SyncScope): Promise<string | null>;
  listObjects(
    prefix: string,
    options: { maxKeys: number; signal: AbortSignal },
  ): Promise<{ objects: ListedSyncObject[]; isTruncated?: boolean }>;
  listMultipartUploads(
    prefix: string,
    options: { maxUploads: number; signal: AbortSignal },
  ): Promise<{ uploads: ListedSyncMultipartUpload[]; isTruncated?: boolean }>;
  deleteObject(key: string, signal: AbortSignal): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string, signal: AbortSignal): Promise<void>;
}

export interface SyncOrphanSweepResult {
  scanned: number;
  deleted: number;
  aborted: number;
  failed: number;
  skipped: number;
  truncated: boolean;
}

interface SweepLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export function startSyncOrphanCollectorLifecycle(input: {
  sweep: (signal: AbortSignal) => Promise<unknown>;
  intervalMs?: number;
  setIntervalFn?: (callback: () => void, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  logger?: SweepLogger;
}): { stop(): Promise<void> } {
  const controller = new AbortController();
  const setIntervalFn = input.setIntervalFn
    ?? ((callback, delay) => setInterval(callback, delay));
  const clearIntervalFn = input.clearIntervalFn
    ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  let stopped = false;
  let active: Promise<void> | null = null;

  const run = () => {
    if (stopped || active) return;
    active = input.sweep(controller.signal)
      .then(() => undefined)
      .catch(() => {
        if (!controller.signal.aborted) {
          input.logger?.warn("Sync orphan sweep failed", { operation: "sweep" });
        }
      })
      .finally(() => {
        active = null;
      });
  };

  const timer = setIntervalFn(run, input.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  (timer as { unref?: () => void })?.unref?.();
  run();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      controller.abort();
      await active;
    },
  };
}

function trustworthyOldDate(value: Date | undefined, cutoff: number): boolean {
  return value instanceof Date && Number.isFinite(value.getTime()) && value.getTime() <= cutoff;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function sweepSyncPublicationOrphans(input: {
  store: SyncOrphanSweepStore;
  scope: SyncScope;
  now?: () => Date;
  graceMs?: number;
  maxListedPerKind?: number;
  maxActions?: number;
  signal?: AbortSignal;
  logger?: SweepLogger;
}): Promise<SyncOrphanSweepResult> {
  const now = (input.now ?? (() => new Date()))();
  const graceMs = input.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const maxListedPerKind = Math.max(
    1,
    Math.min(DEFAULT_MAX_LISTED_PER_KIND, input.maxListedPerKind ?? DEFAULT_MAX_LISTED_PER_KIND),
  );
  const maxActions = Math.max(1, Math.min(DEFAULT_MAX_ACTIONS, input.maxActions ?? DEFAULT_MAX_ACTIONS));
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(graceMs) || graceMs < 60_000) {
    throw new Error("Invalid sync orphan sweep bounds");
  }

  const timeoutSignal = AbortSignal.timeout(DEFAULT_SWEEP_TIMEOUT_MS);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  const prefix = buildSyncScopePrefix(input.scope);
  const stagingPrefix = `${prefix}/staging/`;
  const manifestPrefix = `${prefix}/manifests/`;
  const stagingPattern = new RegExp(
    `^${escapeRegex(stagingPrefix)}[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "i",
  );
  const manifestPattern = new RegExp(
    `^${escapeRegex(manifestPrefix)}[1-9][0-9]*-[a-f0-9]{64}\\.json$`,
  );
  const cutoff = now.getTime() - graceMs;
  const result: SyncOrphanSweepResult = {
    scanned: 0,
    deleted: 0,
    aborted: 0,
    failed: 0,
    skipped: 0,
    truncated: false,
  };
  let actions = 0;

  const [acceptedManifestKey, stagingObjects, manifestObjects, multipartUploads] = await Promise.all([
    input.store.getAcceptedManifestKey(input.scope),
    input.store.listObjects(stagingPrefix, { maxKeys: maxListedPerKind, signal }),
    input.store.listObjects(manifestPrefix, { maxKeys: maxListedPerKind, signal }),
    input.store.listMultipartUploads(stagingPrefix, { maxUploads: maxListedPerKind, signal }),
  ]);
  result.truncated = Boolean(
    stagingObjects.isTruncated || manifestObjects.isTruncated || multipartUploads.isTruncated,
  );

  const deleteCandidates = [
    ...stagingObjects.objects.map((object) => ({ ...object, pattern: stagingPattern })),
    ...manifestObjects.objects.map((object) => ({ ...object, pattern: manifestPattern })),
  ];
  for (const candidate of deleteCandidates) {
    result.scanned += 1;
    const eligible = candidate.pattern.test(candidate.key)
      && candidate.key !== acceptedManifestKey
      && trustworthyOldDate(candidate.lastModified, cutoff);
    if (!eligible) {
      result.skipped += 1;
      continue;
    }
    if (actions >= maxActions || signal.aborted) {
      result.skipped += 1;
      result.truncated = true;
      continue;
    }
    actions += 1;
    try {
      await input.store.deleteObject(candidate.key, signal);
      result.deleted += 1;
    } catch {
      result.failed += 1;
      input.logger?.warn("Sync orphan object cleanup failed", { operation: "delete" });
    }
  }

  for (const upload of multipartUploads.uploads) {
    result.scanned += 1;
    const eligible = stagingPattern.test(upload.key)
      && upload.uploadId.length > 0
      && upload.uploadId.length <= 512
      && trustworthyOldDate(upload.initiated, cutoff);
    if (!eligible) {
      result.skipped += 1;
      continue;
    }
    if (actions >= maxActions || signal.aborted) {
      result.skipped += 1;
      result.truncated = true;
      continue;
    }
    actions += 1;
    try {
      await input.store.abortMultipartUpload(upload.key, upload.uploadId, signal);
      result.aborted += 1;
    } catch {
      result.failed += 1;
      input.logger?.warn("Sync orphan multipart cleanup failed", { operation: "abort" });
    }
  }

  return result;
}
