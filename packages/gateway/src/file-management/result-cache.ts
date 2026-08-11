import { createHash } from "node:crypto";

const MAX_ENTRIES = 512;
const TTL_MS = 10 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 60 * 1_000;

export interface FileOperationCacheInput {
  ownerId: string;
  namespace: string;
  requestId: string;
  payloadHash: string;
}

export interface BatchMovePreflightHashPayload {
  phase: "preflight";
  sources: readonly string[];
  destinationDirectory: string;
}

export interface BatchMoveExecuteHashPayload {
  phase: "execute";
  preflightFingerprint: string;
  conflictChoices?: readonly {
    source: string;
    resolution: "keep-both" | "skip";
  }[];
}

interface CacheEntry<T> {
  payloadHash: string;
  promise: Promise<T>;
  expiresAt: number | undefined;
}

export class FileOperationRequestIdConflictError extends Error {
  readonly code = "request_id_conflict";

  constructor() {
    super("Request identifier was already used with a different payload");
    this.name = "FileOperationRequestIdConflictError";
  }
}

/**
 * A process-local, owner-scoped idempotency cache. Cache keys deliberately do
 * not contain request payloads, credentials, or filesystem paths.
 */
export class FileOperationResultCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.sweepTimer = setInterval(() => this.removeExpired(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  run<T>(input: FileOperationCacheInput, operation: () => Promise<T>): Promise<T> {
    const key = cacheKey(input);
    const existing = this.getEntry(key);
    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        return Promise.reject(new FileOperationRequestIdConflictError());
      }
      return existing.promise as Promise<T>;
    }

    let entry: CacheEntry<T>;
    const promise = Promise.resolve()
      .then(operation)
      .then(
        (result) => {
          entry.expiresAt = Date.now() + TTL_MS;
          return result;
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) this.entries.delete(key);
          throw error;
        },
      );
    entry = { payloadHash: input.payloadHash, promise, expiresAt: undefined };
    this.entries.set(key, entry as CacheEntry<unknown>);
    this.evictLeastRecentlyUsed();
    return promise;
  }

  close(): void {
    clearInterval(this.sweepTimer);
    this.entries.clear();
  }

  private getEntry(key: string): CacheEntry<unknown> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  private evictLeastRecentlyUsed(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}

export function hashBatchMovePreflightPayload(payload: BatchMovePreflightHashPayload): string {
  return hashCanonicalPayload({
    phase: payload.phase,
    sources: payload.sources,
    destinationDirectory: payload.destinationDirectory,
  });
}

export function hashBatchMoveExecutePayload(payload: BatchMoveExecuteHashPayload): string {
  return hashCanonicalPayload({
    phase: payload.phase,
    preflightFingerprint: payload.preflightFingerprint,
    conflictChoices: payload.conflictChoices ?? [],
  });
}

function cacheKey(input: Pick<FileOperationCacheInput, "ownerId" | "namespace" | "requestId">): string {
  return JSON.stringify([input.ownerId, input.namespace, input.requestId]);
}

function hashCanonicalPayload(payload: object): string {
  return createHash("sha256").update(stableJson(payload)).digest("base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
