import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectCustomerVpsDeployMachines } from "../../packages/platform/src/customer-vps-deploy-selection.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import { createCustomerVpsProvisioner } from "../../packages/platform/src/customer-vps-provision.js";
import { createCustomerVpsProvisioningDispatcher } from "../../packages/platform/src/customer-vps-provisioning-dispatch.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from "./customer-vps-fixtures.js";
import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";
import { getHostBundleChannel, getHostBundleRelease, getLatestHostBundleReleaseForPr,
  promoteHostBundleChannel, registerHostBundleRelease, upsertHostBundleRelease } from "../../packages/platform/src/db.js";

const pairVersion = `v0.0.0-collabpair-11111111-1111-4111-8111-111111111111-g1-${"a".repeat(40)}`;
const ordinaryVersion = "v2026.10.31-pr3022-ordinary";
describe("pair test-login bundles stay outside ordinary preview/release selection", () => {
  let f: Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
  beforeEach(async () => { f = await createPreviewPairPostgresFixture(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  const release = (version: string, createdAt = "2026-10-31T00:00:00Z") => ({ version, sourcePr: 3022,
    gitCommit: "a".repeat(40), buildTime: "2026-10-31T00:00:00Z", createdAt,
    bundleKey: `system-bundles/${version}/matrix-host-bundle.tar.gz`, sha256: "b".repeat(64), size: 42 });
  it("selects the ordinary PR bundle even when its pair's test-login bundle is newer", async () => {
    await upsertHostBundleRelease(f.db, release(ordinaryVersion, "2026-10-30T00:00:00Z"));
    await upsertHostBundleRelease(f.db, release(pairVersion));
    expect((await getLatestHostBundleReleaseForPr(f.db, 3022))?.version).toBe(ordinaryVersion);
    expect((await getHostBundleRelease(f.db, pairVersion))?.version).toBe(pairVersion);
  });
  it("does not offer any bundle to an ordinary preview when only pair bundles exist", async () => {
    await upsertHostBundleRelease(f.db, release(pairVersion));
    expect(await getLatestHostBundleReleaseForPr(f.db, 3022)).toBeUndefined();
  });
  it("rejects pair bytes for ordinary fleet deploy and preview provisioning before recording a job", async () => {
    expect(() => selectCustomerVpsDeployMachines([{ handle: "ordinary", provisioningClass: "customer" as const }], { version: pairVersion })).toThrow();
  });
  it("rejects pair bytes for ordinary preview provisioning before recording a job", async () => {
    await upsertHostBundleRelease(f.db, release(pairVersion));
    const hetzner = createMockHetznerClient();
    const context = createCustomerVpsContext({ db: f.db, config: createTestConfig(), hetzner,
      systemStore: createMockCustomerVpsSystemStore() });
    const provisioner = createCustomerVpsProvisioner(context, createCustomerVpsProvisioningDispatcher(context));
    await expect(provisioner.provision({ clerkUserId: "user_test", handle: "ordinary-preview", runtimeSlot: "ordinary-preview", bundleVersion: pairVersion }, "preview", "detached")).rejects.toThrow();
    expect(await f.db.executor.selectFrom("user_machines").selectAll().execute()).toEqual([]);
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });
  it("rejects direct and registration-time channel promotion without partially changing a pointer", async () => {
    await upsertHostBundleRelease(f.db, release(ordinaryVersion));
    await promoteHostBundleChannel(f.db, "dev", ordinaryVersion);
    await upsertHostBundleRelease(f.db, release(pairVersion));
    await expect(promoteHostBundleChannel(f.db, "dev", pairVersion)).rejects.toThrow();
    await expect(registerHostBundleRelease(f.db, release(pairVersion), "stable")).rejects.toThrow();
    expect((await getHostBundleChannel(f.db, "dev"))?.version).toBe(ordinaryVersion);
    expect(await getHostBundleChannel(f.db, "stable")).toBeUndefined();
  });
});
