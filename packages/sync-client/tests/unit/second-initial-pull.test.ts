import { describe, expect, it, vi } from "vitest";
import {
  runInitialPull,
  type InitialPullLogger,
} from "../../src/daemon/index.js";
import type { SyncState, ManifestEntry } from "../../src/daemon/types.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function entry(hash: string, size = 10): ManifestEntry {
  return {
    hash,
    size,
    mtime: Date.now(),
    peerId: "remote-peer",
    version: 1,
  };
}

function logger(): InitialPullLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("runInitialPull", () => {
  it("batches presign requests and downloads with bounded concurrency", async () => {
    const remoteFiles = Object.fromEntries(
      Array.from({ length: 105 }, (_, i) => [`file-${i}.txt`, entry(HASH_A, i + 1)]),
    );
    const syncState: SyncState = { manifestVersion: 1, lastSyncAt: 0, files: {} };
    let activeDownloads = 0;
    let maxActiveDownloads = 0;

    const requestPresignedUrls = vi.fn(async (_client, files) =>
      files.map((file) => ({
        path: file.path,
        url: `https://r2.example.test/${file.path}`,
        expiresIn: 900,
      })),
    );
    const reconcileRemoteFileChange = vi.fn(async (_state, input) => {
      await input.downloadRemote(`/sync/${input.localRel}`);
      return { status: "downloaded" as const };
    });
    const downloadFile = vi.fn(async () => {
      activeDownloads++;
      maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeDownloads--;
    });

    const result = await runInitialPull({
      gatewayClient: { gatewayUrl: "https://app.matrix-os.com", token: "token" },
      syncRoot: "/sync",
      syncState,
      remoteFiles,
      toLocal: (remotePath) => remotePath,
      toRemote: (localPath) => localPath,
      logger: logger(),
      concurrency: 4,
      requestPresignedUrls,
      reconcileRemoteFileChange,
      downloadFile,
      saveSyncState: vi.fn(),
      refreshConflictCopyPathIndex: vi.fn(),
    });

    expect(result).toMatchObject({ pulled: 105, skipped: 0, failed: 0 });
    expect(requestPresignedUrls).toHaveBeenCalledTimes(2);
    expect(requestPresignedUrls.mock.calls[0]![1]).toHaveLength(100);
    expect(requestPresignedUrls.mock.calls[1]![1]).toHaveLength(5);
    expect(maxActiveDownloads).toBeGreaterThan(1);
    expect(maxActiveDownloads).toBeLessThanOrEqual(4);
    expect(downloadFile).toHaveBeenCalledTimes(105);
  });

  it("skips cached files and keeps going when one download fails", async () => {
    const syncState: SyncState = {
      manifestVersion: 1,
      lastSyncAt: 0,
      files: {
        "cached.txt": {
          hash: HASH_A,
          mtime: Date.now(),
          size: 10,
          lastSyncedHash: HASH_A,
        },
      },
    };
    const testLogger = logger();
    const saveSyncState = vi.fn();
    const refreshConflictCopyPathIndex = vi.fn();
    const requestPresignedUrls = vi.fn(async (_client, files) =>
      files.map((file) => ({
        path: file.path,
        url: `https://r2.example.test/${file.path}`,
        expiresIn: 900,
      })),
    );
    const reconcileRemoteFileChange = vi.fn(async (_state, input) => {
      await input.downloadRemote(`/sync/${input.localRel}`);
      return { status: "downloaded" as const };
    });
    const downloadFile = vi.fn(async (url: string) => {
      if (url.endsWith("/bad.txt")) {
        throw new Error("download unavailable");
      }
    });

    const result = await runInitialPull({
      gatewayClient: { gatewayUrl: "https://app.matrix-os.com", token: "token" },
      syncRoot: "/sync",
      syncState,
      remoteFiles: {
        "cached.txt": entry(HASH_A),
        "ok.txt": entry(HASH_B),
        "bad.txt": entry(HASH_C),
        "outside.txt": entry(HASH_B),
      },
      toLocal: (remotePath) => remotePath === "outside.txt" ? null : remotePath,
      toRemote: (localPath) => localPath,
      logger: testLogger,
      concurrency: 2,
      requestPresignedUrls,
      reconcileRemoteFileChange,
      downloadFile,
      saveSyncState,
      refreshConflictCopyPathIndex,
    });

    expect(result).toMatchObject({ pulled: 1, skipped: 1, failed: 1 });
    expect(downloadFile).toHaveBeenCalledTimes(2);
    expect(saveSyncState).toHaveBeenCalledTimes(1);
    expect(refreshConflictCopyPathIndex).toHaveBeenCalledTimes(1);
    expect(testLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: "bad.txt" }),
      "Initial-pull failed",
    );
  });
});
