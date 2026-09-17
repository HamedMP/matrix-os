import { describe, expect, it } from "vitest";
import {
  BackupStatusSchema,
  SyncMappingConfigSchema,
  SyncMappingSchema,
  SyncRuntimeSlotSchema,
  SyncScopeSchema,
  deriveBackupFreshness,
} from "../../packages/contracts/src/index.js";

describe("sync contracts", () => {
  it("accepts a bounded owner and runtime scope", () => {
    expect(SyncScopeSchema.parse({
      ownerId: "user_123",
      runtimeSlot: "primary",
    })).toEqual({
      ownerId: "user_123",
      runtimeSlot: "primary",
    });
  });

  it.each([
    "../primary",
    "UPPERCASE",
    "-leading",
    "trailing-",
    "a".repeat(33),
  ])("rejects unsafe runtime slot %j", (runtimeSlot) => {
    expect(SyncRuntimeSlotSchema.safeParse(runtimeSlot).success).toBe(false);
  });

  it("rejects owner identifiers that cannot safely enter an object key", () => {
    expect(SyncScopeSchema.safeParse({
      ownerId: "owner/other",
      runtimeSlot: "primary",
    }).success).toBe(false);
  });

  it("accepts the versioned multi-mapping configuration contract", () => {
    const config = {
      schemaVersion: 2 as const,
      revision: 3,
      profile: "cloud",
      ownerId: "user_123",
      runtimeSlot: "primary",
      deviceId: "device-macbook",
      enabled: true,
      mappings: [{
        id: "1f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
        label: "Matrix Home",
        localRoot: "/Users/alice/matrixos/cloud",
        remotePrefix: "",
        direction: "two_way" as const,
        enabled: true,
        propagateDeletes: false,
        excludes: ["Work/project-a/"],
      }],
    };

    expect(SyncMappingConfigSchema.parse(config)).toEqual(config);
  });

  it.each(["/absolute", "../escape", "a/../b", "a\\b", "a//b"])(
    "rejects a non-normalized mapping remote prefix %j",
    (remotePrefix) => {
      expect(SyncMappingSchema.safeParse({
        id: "1f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
        label: "Unsafe",
        localRoot: "/tmp/sync",
        remotePrefix,
        direction: "two_way",
        enabled: true,
        propagateDeletes: false,
        excludes: [],
      }).success).toBe(false);
    },
  );

  it("rejects more than 32 mappings and duplicate mapping ids", () => {
    const mapping = {
      id: "1f17e3cb-e080-5a20-9ba3-d6ea45e7eac5",
      label: "Matrix Home",
      localRoot: "/tmp/sync",
      remotePrefix: "",
      direction: "two_way" as const,
      enabled: true,
      propagateDeletes: false,
      excludes: [],
    };
    const base = {
      schemaVersion: 2 as const,
      revision: 0,
      profile: "cloud",
      ownerId: "user_123",
      runtimeSlot: "primary",
      deviceId: "device",
      enabled: true,
    };

    expect(SyncMappingConfigSchema.safeParse({
      ...base,
      mappings: Array.from({ length: 33 }, (_, index) => ({
        ...mapping,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    }).success).toBe(false);
    expect(SyncMappingConfigSchema.safeParse({
      ...base,
      mappings: [mapping, { ...mapping, label: "Duplicate" }],
    }).success).toBe(false);
  });
});

describe("backup status contracts", () => {
  it("derives the documented hourly freshness windows", () => {
    const now = Date.UTC(2026, 8, 17, 12);
    expect(deriveBackupFreshness(now - 2 * 60 * 60 * 1000, now)).toBe("healthy");
    expect(deriveBackupFreshness(now - 3 * 60 * 60 * 1000, now)).toBe("stale");
    expect(deriveBackupFreshness(now - 25 * 60 * 60 * 1000, now)).toBe("critical");
    expect(deriveBackupFreshness(null, now)).toBe("unknown");
  });

  it("keeps attempt, success, scheduler, storage, and restore evidence distinct", () => {
    expect(BackupStatusSchema.parse({
      schemaVersion: 1,
      scheduler: { enabled: true, active: false, nextDueAt: 10 },
      lastAttempt: { attemptedAt: 5, outcome: "failed", errorCode: "upload_failed" },
      lastSuccess: {
        snapshotKey: "system/db/snapshots/2026-09-17T120000Z.dump",
        receiptKey: "system/db/receipts/2026-09-17T120000Z.json",
        sha256: "a".repeat(64),
        size: 42,
        runtimeSlot: "primary",
        completedAt: 1,
        restoreVerifiedAt: null,
      },
      storageReachability: "unreachable",
      freshness: "stale",
      observedAt: 10,
    })).toMatchObject({
      lastAttempt: { outcome: "failed" },
      lastSuccess: { size: 42 },
    });
  });
});
