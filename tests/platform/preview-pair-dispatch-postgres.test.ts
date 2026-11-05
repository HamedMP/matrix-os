import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import { createCustomerVpsProvisioningDispatcher } from "../../packages/platform/src/customer-vps-provisioning-dispatch.js";
import { createMockCustomerVpsSystemStore } from "./customer-vps-fixtures.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { createCustomerVpsService } from "../../packages/platform/src/customer-vps.js";
import { createCustomerVpsProvisioner } from "../../packages/platform/src/customer-vps-provision.js";
import { activeEntitlement } from "./customer-vps-service-test-helper.js";
import { insertProviderDeletion, insertUserMachine } from "../../packages/platform/src/db.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("ordinary provisioning workers cannot boot pair jobs against customer authority", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  it("leaves both pair jobs queued with no provider calls before a verified pair adapter is wired", async () => {
    const context = createCustomerVpsContext({ db: fixture.db, config: createTestConfig(), hetzner: fixture.hetzner,
      systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW) });
    const dispatcher = createCustomerVpsProvisioningDispatcher(context);
    const jobs = await fixture.db.executor.selectFrom("provisioning_jobs").select("job_id").execute();
    for (const job of jobs) expect(await dispatcher.dispatchProvisioningJob(job.job_id, true)).toBe("skipped");
    expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
    expect((await fixture.db.executor.selectFrom("provisioning_jobs").select("status").execute()).map(job => job.status)).toEqual(["queued", "queued"]);
  });
  it("does not let older pair jobs starve a normal customer dispatch batch", async () => {
    const context = createCustomerVpsContext({ db: fixture.db, config: createTestConfig({ reconciliationBatchSize: 1 }),
      hetzner: fixture.hetzner, systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW + 1_000),
      resolveBillingEntitlement: async () => activeEntitlement({ clerkUserId: "user_customer" }) });
    const dispatcher = createCustomerVpsProvisioningDispatcher(context);
    const provisioner = createCustomerVpsProvisioner(context, dispatcher);
    const customer = await fixture.db.transaction(() => provisioner.provision(
      { clerkUserId: "user_customer", handle: "cp-customer", runtimeSlot: "primary" }, "customer", "prepare"));
    expect(await dispatcher.dispatchProvisioningJobs()).toMatchObject({ completed: 1 });
    expect(fixture.hetzner.createServer).toHaveBeenCalledOnce();
    expect((await fixture.db.executor.selectFrom("provisioning_jobs").select("status").where("machine_id", "!=", customer.machineId).execute()).map(row => row.status))
      .toEqual(["queued", "queued"]);
  });
  it("keeps stale pair rows out of ordinary reconciliation before its batch limit", async () => {
    await insertUserMachine(fixture.db, { machineId: "unrelated-customer", clerkUserId: "user_customer", handle: "cp-customer",
      runtimeSlot: "primary", provisioningClass: "customer", status: "provisioning", provisionedAt: new Date(PAIR_NOW + 1_000).toISOString() });
    const service = createCustomerVpsService({ db: fixture.db, config: createTestConfig({ reconciliationBatchSize: 1 }),
      hetzner: fixture.hetzner, systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW + 11 * 60_000) });
    await service.reconcileProvisioning();
    expect((await fixture.db.executor.selectFrom("user_machines").select("status").where("provisioning_class", "=", "preview").execute()).map(row => row.status))
      .toEqual(["provisioning", "provisioning"]);
    expect((await fixture.db.executor.selectFrom("user_machines").select("status").where("machine_id", "=", "unrelated-customer").executeTakeFirstOrThrow()).status).toBe("failed");
    expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
  });
  it.each(["reserved orphan", "inconsistent member"] as const)("denies ordinary authority for a %s", async fault => {
    let machineId: string;
    if (fault === "inconsistent member") {
      const owner = await fixture.db.executor.selectFrom("preview_pair_members").select("machine_id").where("role", "=", "owner").executeTakeFirstOrThrow();
      machineId = owner.machine_id;
      await fixture.db.executor.updateTable("user_machines").set({ handle: "renamed-pair" }).where("machine_id", "=", machineId).execute();
    } else {
      machineId = "44444444-4444-4444-8444-444444444444";
      await insertUserMachine(fixture.db, { machineId, clerkUserId: "user_other_preview", handle: "cp-9999-aaaaaaaa-1-a",
        runtimeSlot: "cp-9999-aaaaaaaa-1-a", provisioningClass: "preview", status: "provisioning", provisionedAt: new Date(PAIR_NOW).toISOString() });
    }
    await insertUserMachine(fixture.db, { machineId: "unrelated-customer", clerkUserId: "user_customer", handle: "cp-customer",
      runtimeSlot: "primary", provisioningClass: "customer", status: "provisioning", provisionedAt: new Date(PAIR_NOW + 1_000).toISOString() });
    const service = createCustomerVpsService({ db: fixture.db, config: createTestConfig({ reconciliationBatchSize: 1 }),
      hetzner: fixture.hetzner, systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW + 11 * 60_000) });
    await service.reconcileProvisioning();
    expect((await fixture.db.executor.selectFrom("user_machines").select("status").where("machine_id", "=", machineId).executeTakeFirstOrThrow()).status).toBe("provisioning");
    expect((await fixture.db.executor.selectFrom("user_machines").select("status").where("machine_id", "=", "unrelated-customer").executeTakeFirstOrThrow()).status).toBe("failed");
  });
  it("reserves pair compensation deletions for the pair consumer before the ordinary batch limit", async () => {
    const owner = await fixture.db.executor.selectFrom("preview_pair_members").selectAll().where("role", "=", "owner").executeTakeFirstOrThrow();
    await insertProviderDeletion(fixture.db, { id: "11111111-1111-4111-8111-111111111111", providerServerId: 801,
      machineId: owner.machine_id, handle: owner.handle, reason: "provision_create_compensation",
      nextAttemptAt: new Date(PAIR_NOW - 2_000).toISOString(), createdAt: new Date(PAIR_NOW).toISOString() });
    await insertProviderDeletion(fixture.db, { id: "99999999-9999-4999-8999-999999999999", providerServerId: 999,
      machineId: null, handle: null, reason: "provision_create_compensation",
      nextAttemptAt: new Date(PAIR_NOW - 1_000).toISOString(), createdAt: new Date(PAIR_NOW).toISOString() });
    const service = createCustomerVpsService({ db: fixture.db, config: createTestConfig({ reconciliationBatchSize: 1 }),
      hetzner: fixture.hetzner, systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW) });
    await service.reconcileProvisioning();
    expect(fixture.hetzner.deleteServer.mock.calls.map(call => call[0])).toEqual([999]);
    expect((await fixture.db.executor.selectFrom("provider_deletion_queue").select("completed_at")
      .where("provider_server_id", "=", 801).executeTakeFirstOrThrow()).completed_at).toBeNull();
  });
  it("keeps pair metadata out of the customer store without starving customer metadata", async () => {
    // Status fixture only: the boundary under test is ordinary worker selection.
    const members = await fixture.db.executor.selectFrom("preview_pair_members").select("machine_id").orderBy("role").execute();
    await fixture.db.transaction(async trx => {
      for (const [index, member] of members.entries()) await trx.executor.updateTable("user_machines").set({ status: "running",
        hetzner_server_id: 800 + index, public_ipv4: `203.0.113.${10 + index}`, last_seen_at: new Date(PAIR_NOW).toISOString() })
        .where("machine_id", "=", member.machine_id).execute();
      await trx.executor.updateTable("provisioning_jobs").set({ status: "completed", encrypted_payload: null }).execute();
    });
    const customerId = "99999999-9999-4999-8999-999999999999";
    await insertUserMachine(fixture.db, { machineId: customerId, clerkUserId: "user_customer", handle: "cp-customer",
      runtimeSlot: "primary", provisioningClass: "customer", status: "running", lastSeenAt: new Date(PAIR_NOW - 1_000).toISOString(),
      hetznerServerId: 999, publicIPv4: "203.0.113.99", imageVersion: fixture.candidate.hostBundleVersion,
      provisionedAt: new Date(PAIR_NOW).toISOString() });
    const store = createMockCustomerVpsSystemStore();
    const service = createCustomerVpsService({ db: fixture.db, config: createTestConfig({ reconciliationBatchSize: 1 }),
      hetzner: fixture.hetzner, systemStore: store, now: () => new Date(PAIR_NOW + 1_000) });
    await service.reconcileProvisioning();
    expect(store.writeVpsMeta.mock.calls.map(call => call[0].machineId)).toEqual([customerId]);
  });
});
