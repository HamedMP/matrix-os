import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import { createCustomerVpsProvisioner } from "../../packages/platform/src/customer-vps-provision.js";
import { createCustomerVpsProvisioningDispatcher } from "../../packages/platform/src/customer-vps-provisioning-dispatch.js";
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from "./customer-vps-fixtures.js";
import { createTestConfig, useCustomerVpsFixture } from "./customer-vps-service-test-helper.js";

describe("pair preparation reuses the actual machine and encrypted-job provisioner", () => {
  let db: PlatformDB;
  useCustomerVpsFixture(value => { db = value!; });
  function setup() {
    const hetzner = createMockHetznerClient();
    const context = createCustomerVpsContext({ db, config: createTestConfig(), hetzner,
      systemStore: createMockCustomerVpsSystemStore() });
    const dispatcher = createCustomerVpsProvisioningDispatcher(context);
    const provisioner = createCustomerVpsProvisioner(context, dispatcher);
    // Exercise the existing production entrypoint with the new internal mode.
    const prepare = () => Reflect.apply(provisioner.provision, undefined, [{
      clerkUserId: "user_pair_owner", handle: "pr-3022", runtimeSlot: "pr-3022",
      accessClerkUserIds: [],
    }, "preview", "prepare"]) as Promise<{ machineId: string }>;
    return { hetzner, prepare };
  }
  it("rejects prepare outside an active transaction before any provider call", async () => {
    const { prepare, hetzner } = setup();
    await expect(prepare()).rejects.toThrow("transaction");
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });
  it("records a queued encrypted job and performs no provider effect before commit, including replay", async () => {
    const { prepare, hetzner } = setup();
    await db.transaction(async trx => {
      const first = await prepare();
      expect(await prepare()).toEqual(first);
      const job = await trx.executor.selectFrom("provisioning_jobs").selectAll().where("machine_id", "=", first.machineId).executeTakeFirstOrThrow();
      expect(job.status).toBe("queued");
      expect(hetzner.createServer).not.toHaveBeenCalled();
    });
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });
  it("a later transaction failure rolls back machines and jobs without an orphan provider server", async () => {
    const { prepare, hetzner } = setup();
    await expect(db.transaction(async () => { await prepare(); throw new Error("second member failed"); })).rejects.toThrow("second member failed");
    const counts = await sql<{ machines: string; jobs: string }>`SELECT
      (SELECT count(*) FROM user_machines) AS machines,
      (SELECT count(*) FROM provisioning_jobs) AS jobs`.execute(db.executor);
    expect(Number(counts.rows[0]!.machines)).toBe(0);
    expect(Number(counts.rows[0]!.jobs)).toBe(0);
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });
});
