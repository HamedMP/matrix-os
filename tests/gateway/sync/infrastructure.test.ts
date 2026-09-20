import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { SyncDatabase } from "../../../packages/gateway/src/sync/sharing-db.js";
import { initializeSyncInfrastructure } from "../../../packages/gateway/src/sync/infrastructure.js";

const fakes = vi.hoisted(() => ({ platform: vi.fn(() => ({ destroy: vi.fn() })), migrate: vi.fn() }));
vi.mock("../../../packages/gateway/src/sync/platform-r2-client.js", () => ({ createPlatformR2Client: fakes.platform }));
vi.mock("../../../packages/gateway/src/sync/sharing-db.js", () => ({ migrateSyncTables: fakes.migrate, deriveGatewaySyncUserSeeds: () => [], ensureSyncUser: vi.fn() }));
vi.mock("../../../packages/gateway/src/sync/db-impl.js", () => ({ createManifestDb: () => ({}), createKyselySharingDb: () => ({}) }));
vi.mock("../../../packages/gateway/src/sync/ws-events.js", () => ({ createPeerRegistry: () => ({}) }));
vi.mock("../../../packages/gateway/src/sync/sharing.js", () => ({ createSharingService: () => ({}) }));

describe("gateway sync composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const name of ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) vi.stubEnv(name, "");
    vi.stubEnv("PLATFORM_INTERNAL_URL", "https://platform.test");
    vi.stubEnv("UPGRADE_TOKEN", "legacy-token");
    vi.stubEnv("MATRIX_HANDLE", "alice");
    vi.stubEnv("MATRIX_SYNC_RUNTIME_TOKEN", "runtime-token");
    vi.stubEnv("MATRIX_MACHINE_ID", "machine-id");
    vi.stubEnv("MATRIX_RUNTIME_SLOT", "secondary");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("passes runtime-bound identity to the broker client", async () => {
    const result = await initializeSyncInfrastructure({} as Kysely<SyncDatabase>);
    expect(fakes.platform).toHaveBeenCalledWith(expect.objectContaining({ token: "runtime-token", machineId: "machine-id", runtimeSlot: "secondary" }));
    expect(result.syncDeps).not.toBeNull();
  });

  it("fails closed rather than sending a scoped token without machine identity", async () => {
    vi.stubEnv("MATRIX_MACHINE_ID", "");
    expect((await initializeSyncInfrastructure({} as Kysely<SyncDatabase>)).syncDeps).toBeNull();
    expect(fakes.platform).not.toHaveBeenCalled();
  });
});
