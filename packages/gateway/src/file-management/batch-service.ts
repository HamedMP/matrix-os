import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";
import {
  BatchMoveExecuteRequestSchema,
  BatchMovePreflightRequestSchema,
  BatchTrashRequestSchema,
  type BatchMoveExecuteRequest,
  type BatchMovePreflightRequest,
} from "./contracts.js";
import {
  FileBatchPreflightError,
  preflightBatchMove,
  type BatchMovePreflightResult,
} from "./preflight.js";
import {
  FileOperationCacheCapacityError,
  FileOperationResultCache,
  hashBatchMoveExecutePayload,
  hashBatchMovePreflightPayload,
} from "./result-cache.js";
import {
  moveFileItem,
  type MoveItemResult,
} from "./move.js";
import type { NoReplaceFileMoveCapability } from "../file-ops.js";
import {
  fileDelete,
  TrashManifestQueue,
  type TrashManifestIo,
  trashEmpty,
  trashList,
  trashRestore,
} from "../trash.js";

const PREFLIGHT_RECORD_LIMIT = 512;
const PREFLIGHT_TTL_MS = 10 * 60 * 1_000;
const ACTIVE_MOVE_LIMIT = 512;

export interface FileBatchMovePreflightInput {
  ownerId: string;
  homePath: string;
  requestId: string;
  sources: string[];
  destinationDirectory: string;
}

export interface FileBatchMoveExecuteInput {
  ownerId: string;
  homePath: string;
  requestId: string;
  preflightFingerprint: string;
  conflictChoices?: BatchMoveExecuteRequest["conflictChoices"];
}

export interface FileBatchMoveExecutionResult {
  results: MoveItemResult[];
  affectedDirectories: string[];
}

export interface FileBatchTrashInput {
  ownerId: string;
  homePath: string;
  requestId: string;
  sources: string[];
}

export interface TrashItemResult {
  source: string;
  code: "trashed" | "source_missing" | "protected" | "invalid_destination" | "failed";
}

export interface FileBatchTrashResult {
  results: TrashItemResult[];
  sourceDirectory: string;
}

export interface FileBatchTrashServiceOptions {
  resultCache?: FileOperationResultCache;
  manifestQueue?: TrashManifestQueue;
  moveCapability?: NoReplaceFileMoveCapability;
  manifestIo?: Partial<TrashManifestIo>;
}

export interface FileBatchMoveServiceOptions {
  resultCache?: FileOperationResultCache;
  preflightResultCache?: FileOperationResultCache;
  executeResultCache?: FileOperationResultCache;
  moveCapability?: NoReplaceFileMoveCapability;
}

interface StoredPreflight {
  homePath: string;
  result: BatchMovePreflightResult;
  expiresAt: number;
}

export class FileBatchStalePreflightError extends Error {
  readonly code = "invalid_destination";

  constructor() {
    super("Batch move preflight is stale or unavailable");
    this.name = "FileBatchStalePreflightError";
  }
}

export class FileBatchMoveUnavailableError extends Error {
  readonly code = "operation_unavailable";

  constructor() {
    super("Batch move is unavailable");
    this.name = "FileBatchMoveUnavailableError";
  }
}

export class FileBatchTrashInvalidRequestError extends Error {
  readonly code = "invalid_destination";

  constructor() {
    super("Batch Trash request is invalid");
    this.name = "FileBatchTrashInvalidRequestError";
  }
}

export class FileBatchTrashUnavailableError extends Error {
  readonly code = "operation_unavailable";

  constructor() {
    super("Batch Trash is unavailable");
    this.name = "FileBatchTrashUnavailableError";
  }
}

export class FileBatchMoveService {
  private readonly preflightResultCache: FileOperationResultCache;
  private readonly executeResultCache: FileOperationResultCache;
  private readonly ownsPreflightResultCache: boolean;
  private readonly ownsExecuteResultCache: boolean;
  private readonly moveCapability: NoReplaceFileMoveCapability | undefined;
  private readonly preflights = new Map<string, StoredPreflight>();
  private readonly active = new Map<string, Promise<unknown>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: FileBatchMoveServiceOptions = {}) {
    this.preflightResultCache = options.preflightResultCache
      ?? options.resultCache
      ?? new FileOperationResultCache();
    this.executeResultCache = options.executeResultCache
      ?? options.resultCache
      ?? new FileOperationResultCache();
    this.ownsPreflightResultCache = options.preflightResultCache === undefined
      && options.resultCache === undefined;
    this.ownsExecuteResultCache = options.executeResultCache === undefined
      && options.resultCache === undefined;
    this.moveCapability = options.moveCapability;
  }

  preflight(input: FileBatchMovePreflightInput): Promise<BatchMovePreflightResult> {
    if (this.closed) return Promise.reject(new FileBatchMoveUnavailableError());
    const parsed = BatchMovePreflightRequestSchema.safeParse({
      requestId: input.requestId,
      phase: "preflight",
      sources: input.sources,
      destinationDirectory: input.destinationDirectory,
    });
    if (!parsed.success || !isServiceIdentityValid(input.ownerId, input.homePath)) {
      return Promise.reject(new FileBatchPreflightError());
    }
    const payloadHash = hashBatchMovePreflightPayload(parsed.data);
    return this.track(
      activeMoveKey(input.ownerId, "move:preflight", input.requestId, payloadHash),
      () => this.runPreflight(input, parsed.data, payloadHash),
    );
  }

  private async runPreflight(
    input: FileBatchMovePreflightInput,
    request: BatchMovePreflightRequest,
    payloadHash: string,
  ): Promise<BatchMovePreflightResult> {
    const result = await this.preflightResultCache.run({
      ownerId: input.ownerId,
      namespace: "move:preflight",
      requestId: input.requestId,
      payloadHash,
    }, () => preflightBatchMove({
      homePath: input.homePath,
      sources: request.sources,
      destinationDirectory: request.destinationDirectory,
    }));

    this.rememberPreflight(input.ownerId, input.requestId, input.homePath, result);
    return result;
  }

  execute(input: FileBatchMoveExecuteInput): Promise<FileBatchMoveExecutionResult> {
    if (this.closed) return Promise.reject(new FileBatchMoveUnavailableError());
    const parsed = BatchMoveExecuteRequestSchema.safeParse({
      requestId: input.requestId,
      phase: "execute",
      preflightFingerprint: input.preflightFingerprint,
      ...(input.conflictChoices ? { conflictChoices: input.conflictChoices } : {}),
    });
    if (!parsed.success || !isServiceIdentityValid(input.ownerId, input.homePath)) {
      return Promise.reject(new FileBatchStalePreflightError());
    }
    const payloadHash = hashBatchMoveExecutePayload(parsed.data);
    return this.track(
      activeMoveKey(input.ownerId, "move:execute", input.requestId, payloadHash),
      () => this.runExecute(input, parsed.data, payloadHash),
    );
  }

  private async runExecute(
    input: FileBatchMoveExecuteInput,
    request: BatchMoveExecuteRequest,
    payloadHash: string,
  ): Promise<FileBatchMoveExecutionResult> {
    return this.executeResultCache.run({
      ownerId: input.ownerId,
      namespace: "move:execute",
      requestId: input.requestId,
      payloadHash,
    }, async () => {
      const preflight = this.getPreflight(input.ownerId, input.requestId);
      if (
        !preflight
        || preflight.homePath !== resolve(input.homePath)
        || preflight.result.preflightFingerprint !== request.preflightFingerprint
      ) {
        throw new FileBatchStalePreflightError();
      }
      const choices = validateConflictChoices(preflight.result, request.conflictChoices);
      const results: MoveItemResult[] = [];
      for (const source of preflight.result.sources) {
        results.push(await moveFileItem({
          homePath: preflight.homePath,
          requestId: input.requestId,
          source,
          destinationDirectory: preflight.result.destinationDirectory,
          conflictResolution: choices.get(source),
        }, { moveCapability: this.moveCapability }));
      }

      return {
        results,
        affectedDirectories: collectAffectedDirectories(
          preflight.result.sources,
          preflight.result.destinationDirectory,
        ),
      };
    });
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.closeOwnedResources();
    }
    return this.closePromise;
  }

  private track<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.active.get(key);
    if (existing) return existing as Promise<T>;
    if (this.active.size >= ACTIVE_MOVE_LIMIT) {
      return Promise.reject(new FileBatchMoveUnavailableError());
    }
    const operation = start();
    this.active.set(key, operation);
    void operation.then(
      () => this.releaseActive(key, operation),
      () => this.releaseActive(key, operation),
    );
    return operation;
  }

  private releaseActive(key: string, operation: Promise<unknown>): void {
    if (this.active.get(key) === operation) this.active.delete(key);
  }

  private async closeOwnedResources(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
    this.active.clear();
    this.preflights.clear();
    if (this.ownsPreflightResultCache) this.preflightResultCache.close();
    if (this.ownsExecuteResultCache) this.executeResultCache.close();
  }

  private rememberPreflight(
    ownerId: string,
    requestId: string,
    homePath: string,
    result: BatchMovePreflightResult,
  ): void {
    const key = preflightKey(ownerId, requestId);
    const existing = this.preflights.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      this.preflights.delete(key);
      this.preflights.set(key, existing);
      return;
    }
    this.removeExpiredPreflights();
    this.preflights.delete(key);
    if (this.preflights.size >= PREFLIGHT_RECORD_LIMIT) {
      throw new FileOperationCacheCapacityError();
    }
    this.preflights.set(key, {
      homePath: resolve(homePath),
      result,
      expiresAt: Date.now() + PREFLIGHT_TTL_MS,
    });
  }

  private getPreflight(ownerId: string, requestId: string): StoredPreflight | undefined {
    const key = preflightKey(ownerId, requestId);
    const preflight = this.preflights.get(key);
    if (!preflight) return undefined;
    if (preflight.expiresAt <= Date.now()) {
      this.preflights.delete(key);
      return undefined;
    }
    this.preflights.delete(key);
    this.preflights.set(key, preflight);
    return preflight;
  }

  private removeExpiredPreflights(): void {
    const now = Date.now();
    for (const [key, preflight] of this.preflights) {
      if (preflight.expiresAt <= now) this.preflights.delete(key);
    }
  }
}

export class FileBatchTrashService {
  private readonly resultCache: FileOperationResultCache;
  private readonly ownsResultCache: boolean;
  private readonly manifestQueue: TrashManifestQueue;
  private readonly ownsManifestQueue: boolean;
  private readonly moveCapability: NoReplaceFileMoveCapability | undefined;
  private readonly manifestIo: Partial<TrashManifestIo> | undefined;
  private readonly active = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: FileBatchTrashServiceOptions = {}) {
    this.resultCache = options.resultCache ?? new FileOperationResultCache();
    this.ownsResultCache = options.resultCache === undefined;
    this.manifestQueue = options.manifestQueue ?? new TrashManifestQueue();
    this.ownsManifestQueue = options.manifestQueue === undefined;
    this.moveCapability = options.moveCapability;
    this.manifestIo = options.manifestIo;
  }

  delete(homePath: string, requestedPath: string) {
    if (this.closed) return Promise.reject(new FileBatchTrashUnavailableError());
    return fileDelete(homePath, requestedPath, {
      manifestQueue: this.manifestQueue,
      moveCapability: this.moveCapability,
      manifestIo: this.manifestIo,
    });
  }

  list(homePath: string) {
    if (this.closed) return Promise.reject(new FileBatchTrashUnavailableError());
    return trashList(homePath, this.manifestQueue);
  }

  restore(homePath: string, trashPath: string) {
    if (this.closed) return Promise.reject(new FileBatchTrashUnavailableError());
    return trashRestore(homePath, trashPath, this.manifestQueue);
  }

  empty(homePath: string) {
    if (this.closed) return Promise.reject(new FileBatchTrashUnavailableError());
    return trashEmpty(homePath, this.manifestQueue);
  }

  trash(input: FileBatchTrashInput): Promise<FileBatchTrashResult> {
    if (this.closed) return Promise.reject(new FileBatchTrashUnavailableError());
    const parsed = BatchTrashRequestSchema.safeParse({
      requestId: input.requestId,
      sources: input.sources,
    });
    if (!parsed.success || !isServiceIdentityValid(input.ownerId, input.homePath)) {
      return Promise.reject(new FileBatchTrashInvalidRequestError());
    }

    const operation = this.resultCache.run({
      ownerId: input.ownerId,
      namespace: "trash",
      requestId: input.requestId,
      payloadHash: hashBatchTrashPayload(parsed.data.sources),
    }, async () => {
      const results: TrashItemResult[] = [];
      for (const source of parsed.data.sources) {
        const result = await fileDelete(
          input.homePath,
          source,
          {
            manifestQueue: this.manifestQueue,
            requestId: input.requestId,
            moveCapability: this.moveCapability,
            manifestIo: this.manifestIo,
          },
        );
        results.push(toTrashItemResult(source, result));
      }
      return {
        results,
        sourceDirectory: posix.dirname(parsed.data.sources[0]),
      };
    });
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    );
    return operation;
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.closeOwnedResources();
    }
    return this.closePromise;
  }

  private async closeOwnedResources(): Promise<void> {
    await Promise.allSettled([...this.active]);
    this.active.clear();
    if (this.ownsManifestQueue) await this.manifestQueue.close();
    if (this.ownsResultCache) this.resultCache.close();
  }
}

export function collectAffectedDirectories(
  sources: readonly string[],
  destinationDirectory: string,
): string[] {
  const directories: string[] = [];
  for (const source of sources) {
    const sourceDirectory = posix.dirname(source);
    if (!directories.includes(sourceDirectory)) directories.push(sourceDirectory);
  }
  if (!directories.includes(destinationDirectory)) directories.push(destinationDirectory);
  return directories;
}

function validateConflictChoices(
  preflight: BatchMovePreflightResult,
  conflictChoices: BatchMoveExecuteRequest["conflictChoices"],
): Map<string, "keep-both" | "skip"> {
  const conflictSources = new Set(preflight.conflicts.map((conflict) => conflict.source));
  const choices = new Map<string, "keep-both" | "skip">();
  for (const choice of conflictChoices ?? []) {
    if (!conflictSources.has(choice.source) || choices.has(choice.source)) {
      throw new FileBatchStalePreflightError();
    }
    choices.set(choice.source, choice.resolution);
  }
  return choices;
}

function preflightKey(ownerId: string, requestId: string): string {
  return JSON.stringify([ownerId, requestId]);
}

function activeMoveKey(
  ownerId: string,
  namespace: "move:preflight" | "move:execute",
  requestId: string,
  payloadHash: string,
): string {
  return JSON.stringify([ownerId, namespace, requestId, payloadHash]);
}

function isServiceIdentityValid(ownerId: string, homePath: string): boolean {
  return ownerId.length > 0 && homePath.length > 0;
}

function hashBatchTrashPayload(sources: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ sources }))
    .digest("base64url");
}

function toTrashItemResult(
  source: string,
  result: { ok: boolean; error?: string; status?: number },
): TrashItemResult {
  if (result.ok) return { source, code: "trashed" };
  if (result.status === 404) return { source, code: "source_missing" };
  if (result.status === 403) return { source, code: "protected" };
  if (result.error === "Invalid path") return { source, code: "invalid_destination" };
  return { source, code: "failed" };
}
