import { describe, expect, it, vi } from "vitest";
import {
  FileBatchMoveService,
  FileBatchMoveUnavailableError,
} from "../../packages/gateway/src/file-management/batch-service.js";
import {
  FileOperationResultCache,
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
  private resolvePending!: (value: unknown) => void;
  private readonly pending = new Promise<unknown>((resolve) => {
    this.resolvePending = resolve;
  });

  override run<T>(
    _input: FileOperationCacheInput,
    _operation: () => Promise<T>,
  ): Promise<T> {
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

describe("FileBatchMoveService lifecycle", () => {
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
