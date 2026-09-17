import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSyncHelperService } from "../../desktop/src/main/sync/sync-helper-service";

const HELPER = {
  schemaVersion: 1 as const,
  protocolVersion: 1 as const,
  cliVersion: "0.3.16",
  platform: "darwin" as const,
  arch: "arm64" as const,
  executable: "/stable/.matrixos/helpers/0.3.16/matrix",
  sha256: "a".repeat(64),
  source: "current" as const,
};

function auth() {
  return {
    getToken: vi.fn(() => "desktop-session-secret"),
    getGatewayOrigin: vi.fn(() => "https://app.matrix-os.com"),
    getStatus: vi.fn(() => ({
      signedIn: true as const,
      handle: "alice",
      userId: "user_alice",
      runtimeSlot: "studio",
      platformHost: "https://app.matrix-os.com",
      authGeneration: 1,
    })),
  };
}

describe("Desktop sync helper service", () => {
  it("passes the Desktop token only through bounded stdin during enablement", async () => {
    const selected = await mkdtemp(join(tmpdir(), "desktop-sync-selection-"));
    const run = vi.fn(async (_helper, args: string[], input?: string) => {
      if (args[0] === "__desktop-enroll") {
        return { ok: true, profile: "desktop", mappingId: "11111111-1111-4111-8111-111111111111", userId: "user_alice", runtimeSlot: "studio" };
      }
      if (args.includes("status")) {
        return { v: 1, ok: true, data: { running: false } };
      }
      throw new Error(`unexpected ${args.join(" ")} ${input ?? ""}`);
    });
    const service = createSyncHelperService({
      auth: auth(),
      installHelper: vi.fn(async () => HELPER),
      verifyHelper: vi.fn(async () => undefined),
      run,
      chooseDirectory: vi.fn(async () => selected),
      fetchBackupStatus: vi.fn(async () => null),
      randomId: () => "22222222-2222-4222-8222-222222222222",
      deviceName: () => "Alice Mac",
    });

    const selection = await service.chooseFolder();
    expect(selection?.displayPath).toBe(selected);
    await service.enable({
      selectionId: selection!.selectionId,
      remotePrefix: "",
      direction: "two_way",
      propagateDeletes: false,
      excludes: [],
    });

    const enrollmentCall = run.mock.calls.find((call) => call[1][0] === "__desktop-enroll")!;
    expect(enrollmentCall[1]).toEqual(["__desktop-enroll"]);
    expect(JSON.stringify(enrollmentCall[1])).not.toContain("desktop-session-secret");
    expect(enrollmentCall[2]).toContain("desktop-session-secret");
    expect(enrollmentCall[2]).not.toContain(HELPER.sha256);
    await expect(service.enable({
      selectionId: selection!.selectionId,
      remotePrefix: "",
      direction: "two_way",
      propagateDeletes: false,
      excludes: [],
    })).rejects.toThrow("sync_folder_selection_expired");
  });

  it("combines strict helper status, mapping config and backup health without credential fields", async () => {
    const selected = await mkdtemp(join(tmpdir(), "desktop-sync-status-"));
    await mkdir(join(selected, "nested"));
    const mapping = {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Matrix Home",
      localRoot: selected,
      remotePrefix: "",
      direction: "two_way",
      enabled: true,
      propagateDeletes: false,
      excludes: [],
    };
    const run = vi.fn(async (_helper, args: string[]) => {
      if (args.includes("status")) return { v: 1, ok: true, data: {
        running: true,
        service: "running",
        auth: "ready",
        connection: "online",
        status: "synced",
        enabled: true,
        paused: false,
        activeTransferCount: 0,
        conflictCount: 0,
        lastSyncAt: 1_800_000_000_000,
        profile: "desktop",
        mappings: [{
          mappingId: mapping.id,
          state: "idle",
          fileCount: 12,
          conflictCount: 0,
          lastSuccessfulReconcileAt: 1_800_000_000_000,
          lastIssue: "permission",
        }],
      } };
      if (args.includes("list")) return { v: 1, ok: true, data: { config: {
        schemaVersion: 2,
        revision: 1,
        profile: "desktop",
        ownerId: "user_alice",
        runtimeSlot: "studio",
        deviceId: "alice-mac",
        enabled: true,
        mappings: [mapping],
      } } };
      throw new Error("unexpected command");
    });
    const service = createSyncHelperService({
      auth: auth(),
      installHelper: vi.fn(async () => HELPER),
      verifyHelper: vi.fn(async () => undefined),
      run,
      chooseDirectory: vi.fn(async () => null),
      fetchBackupStatus: vi.fn(async () => ({
        schemaVersion: 1,
        scheduler: { enabled: true, active: true, nextDueAt: 1_800_003_600_000 },
        lastAttempt: { attemptedAt: 1_800_000_000_000, outcome: "success", errorCode: null },
        lastSuccess: {
          snapshotKey: "database/snapshots/example.dump",
          receiptKey: "database/receipts/example.json",
          sha256: "b".repeat(64),
          size: 128,
          runtimeSlot: "studio",
          completedAt: 1_800_000_000_000,
          restoreVerifiedAt: null,
        },
        storageReachability: "reachable",
        freshness: "healthy",
        observedAt: 1_800_000_000_100,
      })),
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot).toMatchObject({
      capability: "available",
      helperVersion: "0.3.16",
      service: "running",
      runtimeSlot: "studio",
      status: "synced",
      backupState: "available",
      mappings: [{ ...mapping, state: "idle", fileCount: 12, lastIssue: "permission" }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("desktop-session-secret");
  });

  it("keeps configured mappings visible when the daemon is stopped", async () => {
    const mapping = {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Recovery",
      localRoot: "/Users/alice/Recovery",
      remotePrefix: "projects/recovery",
      direction: "two_way",
      enabled: true,
      propagateDeletes: false,
      excludes: ["node_modules/"],
    };
    const run = vi.fn(async (_helper, args: string[]) => {
      if (args.includes("status")) return { v: 1, ok: true, data: { running: false } };
      if (args.includes("list")) return { v: 1, ok: true, data: { config: {
        schemaVersion: 2,
        revision: 4,
        profile: "desktop",
        ownerId: "user_alice",
        runtimeSlot: "studio",
        deviceId: "alice-mac",
        enabled: true,
        mappings: [mapping],
      } } };
      throw new Error("unexpected command");
    });
    const service = createSyncHelperService({
      auth: auth(),
      installHelper: vi.fn(async () => HELPER),
      verifyHelper: vi.fn(async () => undefined),
      run,
      chooseDirectory: vi.fn(async () => null),
      fetchBackupStatus: vi.fn(async () => null),
    });

    await expect(service.getSnapshot()).resolves.toMatchObject({
      service: "stopped",
      connection: "offline",
      status: "offline",
      profile: "desktop",
      runtimeSlot: "studio",
      enabled: true,
      mappings: [{ ...mapping, state: "offline", fileCount: 0 }],
    });
  });

  it("reauthorizes the existing Desktop profile with the session token only on stdin", async () => {
    const run = vi.fn(async (_helper, args: string[], input?: string) => {
      if (args[0] === "__desktop-reauthorize") return { ok: true, profile: "desktop" };
      if (args.includes("status")) return { v: 1, ok: true, data: { running: false } };
      throw new Error(`unexpected ${args.join(" ")} ${input ?? ""}`);
    });
    const service = createSyncHelperService({
      auth: auth(),
      installHelper: vi.fn(async () => HELPER),
      verifyHelper: vi.fn(async () => undefined),
      run,
      chooseDirectory: vi.fn(async () => null),
      fetchBackupStatus: vi.fn(async () => null),
      deviceName: () => "Alice Mac",
    });

    await service.reauthorize();

    const call = run.mock.calls.find((candidate) => candidate[1][0] === "__desktop-reauthorize")!;
    expect(call[1]).toEqual(["__desktop-reauthorize"]);
    expect(call[2]).toContain("desktop-session-secret");
    expect(JSON.stringify(call[1])).not.toContain("desktop-session-secret");
  });
});
