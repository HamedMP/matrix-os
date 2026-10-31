import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import { createCustomerVpsProvisioningDispatcher } from "../../packages/platform/src/customer-vps-provisioning-dispatch.js";
import { createMockCustomerVpsSystemStore } from "./customer-vps-fixtures.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";

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
});
