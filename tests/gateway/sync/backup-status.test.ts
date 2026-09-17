import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBackupStatus } from "../../../packages/gateway/src/sync/backup-status.js";

describe("backup status provider", () => {
  let statusDir: string;

  beforeEach(async () => {
    statusDir = await mkdtemp(join(tmpdir(), "backup-status-"));
    await mkdir(statusDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(statusDir, { recursive: true, force: true });
  });

  it("reports failed attempts independently from the last verified success", async () => {
    const now = Date.UTC(2026, 8, 17, 12);
    await writeFile(join(statusDir, "last-attempt.json"), JSON.stringify({
      attemptedAt: now - 1_000,
      outcome: "failed",
      errorCode: "storage_upload_failed",
    }));
    await writeFile(join(statusDir, "last-success.json"), JSON.stringify({
      snapshotKey: "system/db/snapshots/2026-09-17T080000Z.dump",
      receiptKey: "system/db/receipts/2026-09-17T080000Z.json",
      sha256: "a".repeat(64),
      size: 42,
      runtimeSlot: "primary",
      completedAt: now - 4 * 60 * 60 * 1000,
      restoreVerifiedAt: null,
    }));

    await expect(loadBackupStatus({
      statusDir,
      now,
      timerState: async () => ({ enabled: true, active: false, nextDueAt: now + 1_000 }),
    })).resolves.toMatchObject({
      scheduler: { enabled: true, active: false },
      lastAttempt: { outcome: "failed", errorCode: "storage_upload_failed" },
      lastSuccess: { size: 42 },
      storageReachability: "unreachable",
      freshness: "stale",
    });
  });

  it("returns unknown evidence for missing, malformed, or symlinked files", async () => {
    await writeFile(join(statusDir, "outside.json"), "{}");
    await symlink(join(statusDir, "outside.json"), join(statusDir, "last-success.json"));
    await writeFile(join(statusDir, "last-attempt.json"), "{bad");

    await expect(loadBackupStatus({
      statusDir,
      now: 10,
      timerState: async () => ({ enabled: null, active: null, nextDueAt: null }),
    })).resolves.toMatchObject({
      lastAttempt: null,
      lastSuccess: null,
      storageReachability: "unknown",
      freshness: "unknown",
    });
  });
});
