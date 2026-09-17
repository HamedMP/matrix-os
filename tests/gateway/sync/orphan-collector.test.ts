import { describe, expect, it, vi } from "vitest";
import type { SyncScope } from "@matrix-os/contracts";
import {
  startSyncOrphanCollectorLifecycle,
  sweepSyncPublicationOrphans,
  type SyncOrphanSweepStore,
} from "../../../packages/gateway/src/sync/orphan-collector.js";

const scope: SyncScope = { ownerId: "user_alice", runtimeSlot: "primary" };
const scopePrefix = "matrixos-sync/user_alice";
const now = new Date("2026-09-17T12:00:00.000Z");
const old = new Date("2026-09-01T12:00:00.000Z");
const recent = new Date("2026-09-16T12:00:00.000Z");

function store(overrides: Partial<SyncOrphanSweepStore> = {}): SyncOrphanSweepStore {
  return {
    getAcceptedManifestKey: vi.fn(async () => `${scopePrefix}/manifests/4-${"a".repeat(64)}.json`),
    listObjects: vi.fn(async () => ({ objects: [] })),
    listMultipartUploads: vi.fn(async () => ({ uploads: [] })),
    deleteObject: vi.fn(async () => undefined),
    abortMultipartUpload: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("sync publication orphan collector", () => {
  it("reclaims only old staging, unaccepted generations, and interrupted staging uploads", async () => {
    const accepted = `${scopePrefix}/manifests/4-${"a".repeat(64)}.json`;
    const oldGeneration = `${scopePrefix}/manifests/3-${"b".repeat(64)}.json`;
    const oldStaging = `${scopePrefix}/staging/00000000-0000-4000-8000-000000000001`;
    const recentStaging = `${scopePrefix}/staging/00000000-0000-4000-8000-000000000002`;
    const interrupted = `${scopePrefix}/staging/00000000-0000-4000-8000-000000000003`;
    const testStore = store({
      getAcceptedManifestKey: vi.fn(async () => accepted),
      listObjects: vi.fn(async (prefix) => prefix.endsWith("/staging/")
        ? {
            objects: [
              { key: oldStaging, lastModified: old },
              { key: recentStaging, lastModified: recent },
            ],
          }
        : {
            objects: [
              { key: accepted, lastModified: old },
              { key: oldGeneration, lastModified: old },
            ],
          }),
      listMultipartUploads: vi.fn(async () => ({
        uploads: [
          { key: interrupted, uploadId: "upload-old", initiated: old },
          { key: recentStaging, uploadId: "upload-new", initiated: recent },
        ],
      })),
    });

    const result = await sweepSyncPublicationOrphans({
      store: testStore,
      scope,
      now: () => now,
      graceMs: 7 * 24 * 60 * 60 * 1_000,
    });

    expect(testStore.deleteObject).toHaveBeenCalledTimes(2);
    expect(testStore.deleteObject).toHaveBeenCalledWith(oldStaging, expect.any(AbortSignal));
    expect(testStore.deleteObject).toHaveBeenCalledWith(oldGeneration, expect.any(AbortSignal));
    expect(testStore.deleteObject).not.toHaveBeenCalledWith(accepted, expect.anything());
    expect(testStore.deleteObject).not.toHaveBeenCalledWith(recentStaging, expect.anything());
    expect(testStore.abortMultipartUpload).toHaveBeenCalledWith(
      interrupted,
      "upload-old",
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({ scanned: 6, deleted: 2, aborted: 1, failed: 0 });
  });

  it("rejects unexpected provider keys and entries without trustworthy timestamps", async () => {
    const expectedPrefix = `${scopePrefix}/staging/`;
    const testStore = store({
      listObjects: vi.fn(async (prefix) => prefix === expectedPrefix
        ? {
            objects: [
              { key: `${scopePrefix}/staging/not-a-uuid`, lastModified: old },
              { key: `${scopePrefix}/objects/sha256/${"c".repeat(64)}`, lastModified: old },
              { key: `${scopePrefix}/staging/00000000-0000-4000-8000-000000000004` },
            ],
          }
        : { objects: [] }),
      listMultipartUploads: vi.fn(async () => ({
        uploads: [{
          key: `${scopePrefix}/staging/00000000-0000-4000-8000-000000000005`,
          uploadId: "upload-without-date",
        }],
      })),
    });

    const result = await sweepSyncPublicationOrphans({ store: testStore, scope, now: () => now });

    expect(testStore.deleteObject).not.toHaveBeenCalled();
    expect(testStore.abortMultipartUpload).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 4, deleted: 0, aborted: 0, failed: 0, skipped: 4 });
  });

  it("caps destructive work and isolates one deletion failure", async () => {
    const candidates = Array.from({ length: 4 }, (_, index) => ({
      key: `${scopePrefix}/staging/00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      lastModified: old,
    }));
    const deleteObject = vi.fn(async (key: string) => {
      if (key === candidates[0]!.key) throw new Error("provider detail must stay private");
    });
    const testStore = store({
      listObjects: vi.fn(async (prefix) => prefix.endsWith("/staging/")
        ? { objects: candidates, isTruncated: true }
        : { objects: [] }),
      deleteObject,
    });

    const result = await sweepSyncPublicationOrphans({
      store: testStore,
      scope,
      now: () => now,
      maxActions: 2,
      logger: { warn: vi.fn() },
    });

    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ deleted: 1, failed: 1, truncated: true });
  });

  it("runs lifecycle sweeps immediately, serially, and aborts on shutdown", async () => {
    let tick: (() => void) | undefined;
    let release: (() => void) | undefined;
    const sweep = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
    });
    const clearIntervalFn = vi.fn();
    const lifecycle = startSyncOrphanCollectorLifecycle({
      sweep,
      intervalMs: 60_000,
      setIntervalFn: (callback) => {
        tick = callback;
        return 17;
      },
      clearIntervalFn,
      logger: { warn: vi.fn() },
    });

    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1));
    tick?.();
    expect(sweep).toHaveBeenCalledTimes(1);

    release?.();
    await vi.waitFor(() => {
      tick?.();
      expect(sweep).toHaveBeenCalledTimes(2);
    });

    await lifecycle.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(17);
    expect(sweep.mock.calls[1]?.[0].aborted).toBe(true);
  });
});
