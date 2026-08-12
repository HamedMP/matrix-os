import { describe, expect, it, vi } from "vitest";
import {
  FileBatchMoveService,
  FileBatchMoveUnavailableError,
} from "../../packages/gateway/src/file-management/batch-service.js";
import {
  FileOperationCacheCapacityError,
  FileOperationResultCache,
  FileOperationRequestIdConflictError,
  type FileOperationCacheInput,
} from "../../packages/gateway/src/file-management/result-cache.js";
import type { BatchMovePreflightResult } from "../../packages/gateway/src/file-management/preflight.js";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const preflightResult: BatchMovePreflightResult = {
  sources: ["projects/a.md"],
  destinationDirectory: "archive",
  conflicts: [],
  invalid: [],
  preflightFingerprint: "fingerprint-a",
};

class DeferredResultCache extends FileOperationResultCache {
  closeCalls = 0;
  runCalls = 0;
  private resolvePending!: (value: unknown) => void;
  private readonly pending = new Promise<unknown>((resolve) => {
    this.resolvePending = resolve;
  });

  override run<T>(
    _input: FileOperationCacheInput,
    _operation: () => Promise<T>,
  ): Promise<T> {
    this.runCalls += 1;
    return this.pending as Promise<T>;
  }

  resolve(value: unknown): void {
    this.resolvePending(value);
  }

  override close(): void {
    this.closeCalls += 1;
    super.close();
  }
}

class NamespaceResultCache extends FileOperationResultCache {
  override run<T>(
    input: FileOperationCacheInput,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (input.namespace === "move:preflight") {
      return Promise.resolve({ ...preflightResult, sources: [] }) as Promise<T>;
    }
    return operation();
  }
}

describe("FileBatchMoveService lifecycle", () => {
  it("shares one tracked operation for a large identical pending replay", async () => {
    const resultCache = new DeferredResultCache();
    const service = new FileBatchMoveService({ resultCache });
    const operations = Array.from({ length: 5_000 }, () => service.preflight({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    }));
    const allShared = operations.every((operation) => operation === operations[0]);
    const runCallsWhilePending = resultCache.runCalls;
    const close = service.close();
    let closeSettled = false;
    void close.then(() => { closeSettled = true; });
    await Promise.resolve();
    const closeSettledWhilePending = closeSettled;

    resultCache.resolve(preflightResult);
    await Promise.all(operations);
    await close;
    resultCache.close();

    expect(allShared).toBe(true);
    expect(runCallsWhilePending).toBe(1);
    expect(closeSettledWhilePending).toBe(false);
  });

  it("preserves payload conflicts at capacity and rejects only new identities", async () => {
    const resultCache = new DeferredResultCache();
    const service = new FileBatchMoveService({ resultCache });
    const input = (index: number) => ({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    });
    const accepted = Array.from({ length: 512 }, (_, index) => service.preflight(input(index)));
    const duplicate = service.preflight(input(0));
    let conflictError: unknown;
    const conflict = service.preflight({
      ...input(0),
      destinationDirectory: "other",
    }).catch((error: unknown) => { conflictError = error; });
    let overflowError: unknown;
    let overflowState: "pending" | "resolved" | "rejected" = "pending";
    const overflow = service.preflight(input(512)).then(
      (result) => { overflowState = "resolved"; return result; },
      (error: unknown) => { overflowState = "rejected"; overflowError = error; },
    );
    await Promise.resolve();
    await Promise.resolve();
    const duplicateShared = duplicate === accepted[0];
    const overflowStateWhileFull: string = overflowState;
    const runCallsWhileFull = resultCache.runCalls;

    resultCache.resolve(preflightResult);
    await Promise.all([...accepted, duplicate, conflict, overflow]);
    const afterRelease = service.preflight(input(512));
    await expect(afterRelease).rejects.toBeInstanceOf(FileOperationCacheCapacityError);
    await service.close();
    resultCache.close();

    expect(duplicateShared).toBe(true);
    expect(conflictError).toBeInstanceOf(FileOperationRequestIdConflictError);
    expect(overflowStateWhileFull).toBe("rejected");
    expect(overflowError).toBeInstanceOf(FileBatchMoveUnavailableError);
    expect(runCallsWhileFull).toBe(512);
    expect(resultCache.runCalls).toBe(513);
  });

  it("separates preflight and execute identities for the same request ID", async () => {
    const resultCache = new NamespaceResultCache();
    const service = new FileBatchMoveService({ resultCache });
    await service.preflight({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    });

    await expect(service.execute({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      preflightFingerprint: "fingerprint-a",
    })).resolves.toEqual({
      results: [],
      affectedDirectories: ["archive"],
    });
    await service.close();
    resultCache.close();
  });

  it("drains accepted work, shares concurrent close, and rejects work after close", async () => {
    const resultCache = new DeferredResultCache();
    const service = new FileBatchMoveService({ resultCache });
    const preflight = service.preflight({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    });

    const firstClose = service.close();
    const secondClose = service.close();
    let closeSettled = false;
    void firstClose.then(() => { closeSettled = true; });
    await Promise.resolve();

    expect(firstClose).toBe(secondClose);
    expect(closeSettled).toBe(false);
    resultCache.resolve(preflightResult);
    await expect(preflight).resolves.toEqual(preflightResult);
    await firstClose;
    await expect(service.preflight({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      sources: ["projects/a.md"],
      destinationDirectory: "archive",
    })).rejects.toBeInstanceOf(FileBatchMoveUnavailableError);
    await expect(service.execute({
      ownerId: "owner-a",
      homePath: "/owner/home",
      requestId,
      preflightFingerprint: "fingerprint-a",
    })).rejects.toBeInstanceOf(FileBatchMoveUnavailableError);

    expect(resultCache.closeCalls).toBe(0);
    resultCache.close();
    expect(resultCache.closeCalls).toBe(1);
  });

  it("closes an owned result cache exactly once", async () => {
    const closeCache = vi.spyOn(FileOperationResultCache.prototype, "close");
    const service = new FileBatchMoveService();

    await Promise.all([service.close(), service.close(), service.close()]);

    expect(closeCache).toHaveBeenCalledOnce();
    closeCache.mockRestore();
  });
});
