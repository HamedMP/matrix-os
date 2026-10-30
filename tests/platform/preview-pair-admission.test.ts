import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";
import { previewPairConfigurationFixture, previewPairManifestFixture, PAIR_NOW } from "./preview-pair-test-support.js";
import { loadPreviewPairConfig, type EnabledPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { admitPreviewPair } from "../../packages/platform/src/preview-pair/admission.js";
import { preparePreviewPairMember } from "../../packages/platform/src/preview-pair/prepare.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import { createCustomerVpsProvisioner } from "../../packages/platform/src/customer-vps-provision.js";
import { createCustomerVpsProvisioningDispatcher } from "../../packages/platform/src/customer-vps-provisioning-dispatch.js";
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from "./customer-vps-fixtures.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { insertProvisioningJob, sealProvisioningPayload } from "../../packages/platform/src/customer-vps-provisioning-jobs.js";
import { upsertHostBundleRelease, insertUserMachine } from "../../packages/platform/src/db.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("pair admission at the actual PostgreSQL transaction boundary", () => {
  let fixture: Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
  const config = loadPreviewPairConfig(previewPairConfigurationFixture()) as EnabledPreviewPairConfig;
  const manifest = previewPairManifestFixture();
  const candidate = { sourceSha: manifest.sourceSha, hostBundleVersion: manifest.members.owner.installedVersion,
    hostBundleSha256: "c".repeat(64), desktopArtifacts: manifest.desktopArtifacts,
    browserOrigin: manifest.browserOrigin, apiOrigin: manifest.apiOrigin,
    identityIssuer: manifest.identityIssuer, platformSource: manifest.platformSource };
  const input = () => ({ pairId: manifest.pairId, pr: manifest.pr, requesterId: "user_requester",
    sourceSha: manifest.sourceSha, candidate });
  beforeEach(async () => {
    fixture = await createPreviewPairPostgresFixture();
    await upsertHostBundleRelease(fixture.db, { version: candidate.hostBundleVersion, channel: null,
      sha256: candidate.hostBundleSha256, gitCommit: manifest.sourceSha, sourcePr: manifest.pr,
      buildTime: new Date(PAIR_NOW).toISOString(), bundleKey: "test/bundle.tar.gz", size: 123 });
  }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  function setup() {
    const hetzner = createMockHetznerClient();
    const context = createCustomerVpsContext({ db: fixture.db, config: createTestConfig(), hetzner,
      systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW) });
    const provisioner = createCustomerVpsProvisioner(context, createCustomerVpsProvisioningDispatcher(context));
    return { hetzner, prepare: (pairId: string, generation: number, role: "owner" | "member") =>
      preparePreviewPairMember(context, provisioner, pairId, generation, role) };
  }
  it("commits exactly two distinct owner-only Preview machines and durable queued jobs", async () => {
    const { prepare, hetzner } = setup();
    const pair = await admitPreviewPair(fixture.db, config, input(), prepare, PAIR_NOW);
    expect(pair.state).toBe("preparing");
    const members = await fixture.db.executor.selectFrom("preview_pair_members").selectAll().orderBy("role").execute();
    expect(members).toHaveLength(2);
    expect(new Set(members.map(m => m.machine_id)).size).toBe(2);
    const machines = await fixture.db.executor.selectFrom("user_machines").selectAll().execute();
    expect(machines.every(m => m.provisioning_class === "preview" && m.runtime_slot === m.handle)).toBe(true);
    expect(hetzner.createServer).not.toHaveBeenCalled();
    expect((await fixture.db.executor.selectFrom("provisioning_jobs").selectAll().execute()).map(j => j.status)).toEqual(["queued", "queued"]);
  });
  it("rolls back fixture lease, pair, both machine records and jobs if member preparation fails", async () => {
    const { prepare, hetzner } = setup();
    await expect(admitPreviewPair(fixture.db, config, input(), async (...args) => {
      if (args[2] === "member") throw new Error("member preparation failed");
      return prepare(...args);
    }, PAIR_NOW)).rejects.toThrow("member preparation failed");
    for (const table of ["preview_pairs", "preview_pair_members", "user_machines", "provisioning_jobs"] as const) {
      expect(await fixture.db.executor.selectFrom(table).selectAll().execute(), table).toHaveLength(0);
    }
    expect(hetzner.createServer).not.toHaveBeenCalled();
  });
  it("concurrent duplicate requests converge on one pair without extending hard expiry", async () => {
    const { prepare } = setup();
    const results = await Promise.all([admitPreviewPair(fixture.db, config, input(), prepare, PAIR_NOW),
      admitPreviewPair(fixture.db, config, { ...input(), pairId: randomUUID() }, prepare, PAIR_NOW + 1_000)]);
    expect(results[0]!.pair_id).toBe(results[1]!.pair_id);
    expect(results[0]!.expires_at).toBe(results[1]!.expires_at);
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  });
  it("a second PR queues the whole pair while the fixture is leased", async () => {
    const { prepare } = setup();
    await admitPreviewPair(fixture.db, config, input(), prepare, PAIR_NOW);
    const nextId = randomUUID();
    const nextCandidate = { ...candidate,
      browserOrigin: candidate.browserOrigin.replace("11111111", nextId.slice(0, 8)),
      apiOrigin: candidate.apiOrigin.replace("11111111", nextId.slice(0, 8)) };
    const queued = await admitPreviewPair(fixture.db, config, { ...input(), pairId: nextId, pr: 3023, candidate: nextCandidate }, prepare, PAIR_NOW);
    expect(queued.state).toBe("queued");
    expect(queued.fixture_id).toBeNull();
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  });
  it("an explicit owner quota failure rolls back both reservations", async () => {
    const { prepare } = setup();
    // Existing production quota is reused, not replaced with a pair-only counter.
    const context = createCustomerVpsContext({ db: fixture.db, config: createTestConfig({ previewProvisioningLimit: 0 }),
      hetzner: createMockHetznerClient(), systemStore: createMockCustomerVpsSystemStore() });
    const provisioner = createCustomerVpsProvisioner(context, createCustomerVpsProvisioningDispatcher(context));
    await expect(admitPreviewPair(fixture.db, config, input(), (id, gen, role) =>
      role === "owner" ? prepare(id, gen, role) : preparePreviewPairMember(context, provisioner, id, gen, role), PAIR_NOW)).rejects.toThrow("capacity");
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(0);
    expect((await sql<{ count: string }>`SELECT count(*) FROM preview_pairs`.execute(fixture.db.executor)).rows[0]!.count).toBe("0");
  });
  it("never reclassifies a pre-existing customer machine occupying a reserved handle", async () => {
    const machineId = randomUUID();
    await insertUserMachine(fixture.db, { machineId, clerkUserId: "user_pair_owner",
      handle: manifest.members.owner.handle, runtimeSlot: manifest.members.owner.runtimeSlot,
      provisioningClass: "customer", status: "provisioning", imageVersion: candidate.hostBundleVersion,
      provisionedAt: new Date(PAIR_NOW).toISOString() });
    await insertProvisioningJob(fixture.db, { jobId: randomUUID(), machineId,
      encryptedPayload: sealProvisioningPayload({ registrationToken: "test-registration", postgresPassword: "test-password" }, "platform-secret"),
      availableAt: new Date(PAIR_NOW).toISOString(), createdAt: new Date(PAIR_NOW).toISOString() });
    const { prepare } = setup();
    await expect(admitPreviewPair(fixture.db, config, input(), prepare, PAIR_NOW)).rejects.toThrow("unavailable");
    expect((await fixture.db.executor.selectFrom("user_machines").selectAll().where("machine_id", "=", machineId)
      .executeTakeFirstOrThrow()).provisioning_class).toBe("customer");
    expect(await fixture.db.executor.selectFrom("preview_pairs").selectAll().execute()).toHaveLength(0);
  });
});
