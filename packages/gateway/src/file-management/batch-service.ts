import { posix, resolve } from "node:path";
import {
  BatchMoveExecuteRequestSchema,
  BatchMovePreflightRequestSchema,
  type BatchMoveExecuteRequest,
} from "./contracts.js";
import {
  FileBatchPreflightError,
  preflightBatchMove,
  type BatchMovePreflightResult,
} from "./preflight.js";
import {
  FileOperationResultCache,
  hashBatchMoveExecutePayload,
  hashBatchMovePreflightPayload,
} from "./result-cache.js";
import {
  moveFileItem,
  type MoveItemResult,
} from "./move.js";
import type { NoReplaceFileMoveCapability } from "../file-ops.js";

const PREFLIGHT_RECORD_LIMIT = 512;
const PREFLIGHT_TTL_MS = 10 * 60 * 1_000;

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

export interface FileBatchMoveServiceOptions {
  resultCache?: FileOperationResultCache;
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

export class FileBatchMoveService {
  private readonly resultCache: FileOperationResultCache;
  private readonly ownsResultCache: boolean;
  private readonly moveCapability: NoReplaceFileMoveCapability | undefined;
  private readonly preflights = new Map<string, StoredPreflight>();

  constructor(options: FileBatchMoveServiceOptions = {}) {
    this.resultCache = options.resultCache ?? new FileOperationResultCache();
    this.ownsResultCache = options.resultCache === undefined;
    this.moveCapability = options.moveCapability;
  }

  async preflight(input: FileBatchMovePreflightInput): Promise<BatchMovePreflightResult> {
    const parsed = BatchMovePreflightRequestSchema.safeParse({
      requestId: input.requestId,
      phase: "preflight",
      sources: input.sources,
      destinationDirectory: input.destinationDirectory,
    });
    if (!parsed.success || !isServiceIdentityValid(input.ownerId, input.homePath)) {
      throw new FileBatchPreflightError();
    }

    const result = await this.resultCache.run({
      ownerId: input.ownerId,
      namespace: "move:preflight",
      requestId: input.requestId,
      payloadHash: hashBatchMovePreflightPayload(parsed.data),
    }, () => preflightBatchMove({
      homePath: input.homePath,
      sources: parsed.data.sources,
      destinationDirectory: parsed.data.destinationDirectory,
    }));

    this.rememberPreflight(input.ownerId, input.requestId, input.homePath, result);
    return result;
  }

  async execute(input: FileBatchMoveExecuteInput): Promise<FileBatchMoveExecutionResult> {
    const parsed = BatchMoveExecuteRequestSchema.safeParse({
      requestId: input.requestId,
      phase: "execute",
      preflightFingerprint: input.preflightFingerprint,
      ...(input.conflictChoices ? { conflictChoices: input.conflictChoices } : {}),
    });
    if (!parsed.success || !isServiceIdentityValid(input.ownerId, input.homePath)) {
      throw new FileBatchStalePreflightError();
    }

    return this.resultCache.run({
      ownerId: input.ownerId,
      namespace: "move:execute",
      requestId: input.requestId,
      payloadHash: hashBatchMoveExecutePayload(parsed.data),
    }, async () => {
      const preflight = this.getPreflight(input.ownerId, input.requestId);
      if (
        !preflight
        || preflight.homePath !== resolve(input.homePath)
        || preflight.result.preflightFingerprint !== parsed.data.preflightFingerprint
      ) {
        throw new FileBatchStalePreflightError();
      }
      const choices = validateConflictChoices(preflight.result, parsed.data.conflictChoices);
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

      const sourceDirectory = posix.dirname(preflight.result.sources[0] ?? "");
      return {
        results,
        affectedDirectories: [...new Set([sourceDirectory, preflight.result.destinationDirectory])],
      };
    });
  }

  close(): void {
    this.preflights.clear();
    if (this.ownsResultCache) this.resultCache.close();
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
    while (this.preflights.size >= PREFLIGHT_RECORD_LIMIT) {
      const oldest = this.preflights.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.preflights.delete(oldest);
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

function isServiceIdentityValid(ownerId: string, homePath: string): boolean {
  return ownerId.length > 0 && homePath.length > 0;
}
