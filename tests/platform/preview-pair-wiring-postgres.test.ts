import { Agent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewPairPostgresFixture } from "./preview-pair-postgres-support.js";
import { createIsolatedPreviewPairDatabase } from "./preview-pair-isolated-postgres.js";
import { previewPairConfigurationFixture, PAIR_NOW } from "./preview-pair-test-support.js";
import { previewPairProvenanceFixture } from "./preview-pair-provenance-fixture.js";
import { candidateRuntimeEnvironment } from "./preview-pair-candidate-env.js";
import { createTestConfig } from "./customer-vps-service-test-helper.js";
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from "./customer-vps-fixtures.js";
import { loadPreviewPairConfig, type EnabledPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { createPreviewPairRuntime, type PreviewPairRuntimeOptions } from "../../packages/platform/src/preview-pair/wiring.js";
import { createPreviewPairRuntimeOnlyService } from "../../packages/platform/src/preview-pair/candidate-runtime.js";
import { createCustomerVpsContext } from "../../packages/platform/src/customer-vps-context.js";
import { createAiFundedPolicyRepository } from "../../packages/platform/src/ai-funded-policy-repository.js";
import { loadPreviewRuntimeAccessConfig } from "../../packages/platform/src/preview-runtime-access.js";
import { insertProviderDeletion, insertUserMachine, upsertHostBundleRelease } from "../../packages/platform/src/db.js";
import type { HetznerServer } from "../../packages/platform/src/customer-vps-hetzner.js";
import { bootstrapPlatformCollaborationDatabase } from "../../packages/platform/src/collaboration/database.js";
import { bootstrapPlatformRuntimeEndpointDatabase } from "../../packages/platform/src/collaboration/runtime-endpoints.js";

/** Real admission, durable dispatch, projection and registration. Cloud/GitHub/
 * identity/provider/funded-host HTTP are explicit fixtures, not live acceptance. */
describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("paired runtime production composition", () => {
  let source: Awaited<ReturnType<typeof createPreviewPairPostgresFixture>>;
  let target: Awaited<ReturnType<typeof createIsolatedPreviewPairDatabase>>;
  let dispatcher: Agent;
  const hostSecret = "isolated-host-" + "p".repeat(40), controlSecret = "isolated-control-" + "c".repeat(40);
  beforeEach(async () => {
    source = await createPreviewPairPostgresFixture();
    try {
      target = await createIsolatedPreviewPairDatabase(); dispatcher = new Agent();
      await bootstrapPlatformCollaborationDatabase(target.db.kysely as never);
      await bootstrapPlatformRuntimeEndpointDatabase(target.db.kysely as never);
    }
    catch (error: unknown) { await source.destroy(); throw error; }
  }, 30_000);
  afterEach(async () => { await dispatcher?.close(); try { await target?.destroy(); } finally { await source?.destroy(); } });
  async function setup(destination = target.db) {
    const config = loadPreviewPairConfig(previewPairConfigurationFixture()) as EnabledPreviewPairConfig;
    const proof = previewPairProvenanceFixture(), version = proof.input.hostBundleVersion;
    await upsertHostBundleRelease(source.db, { version, channel: null, sourcePr: proof.expected.pr,
      gitCommit: proof.expected.sourceSha, sha256: proof.input.hostBundleSha256,
      bundleKey: "preview/fixture.tar.gz", size: 123, buildTime: new Date(PAIR_NOW).toISOString() });
    await insertUserMachine(source.db, { machineId: "unrelated-customer", clerkUserId: "user_customer", handle: "customer",
      runtimeSlot: "primary", provisioningClass: "customer", status: "running", provisionedAt: new Date(PAIR_NOW).toISOString() });
    const servers: HetznerServer[] = []; // Fixture cap two, discarded after each test.
    const inventory = async (selector: string) => ({ servers: servers.filter(server => `machine_id=${server.labels?.machine_id}` === selector), complete: true });
    const provider = createMockHetznerClient({ inspectServersByLabel: vi.fn(inventory),
      listServersByLabel: vi.fn(async selector => (await inventory(selector)).servers) });
    provider.createServer.mockImplementation(async request => {
      const index = provider.createServer.mock.calls.length;
      if (index > 2) throw new Error("Two-computer fixture exceeded");
      const server: HetznerServer = { id: 800 + index, status: "running", serverType: "cpx22", publicIPv4: index === 1 ? "8.8.8.8" : "1.1.1.1",
        publicIPv6: "2001:db8::/64", labels: request.labels };
      servers.push(server); return server;
    });
    provider.getServer.mockImplementation(async id => servers.find(server => server.id === id) ?? null);
    provider.deleteServer.mockImplementation(async id => {
      const index = servers.findIndex(server => server.id === id);
      if (index >= 0) servers.splice(index, 1);
    });
    const context = createCustomerVpsContext({ db: source.db, config: createTestConfig({ platformSecret: hostSecret,
      r2PrefixRoot: "preview-pair-test", fundedAiEnabled: false }),
      hetzner: { ...provider, withSignal: () => provider }, systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(PAIR_NOW) });
    const repository = createAiFundedPolicyRepository({ db: source.db, credentialHashSecret: "h".repeat(48), now: () => new Date(PAIR_NOW) });
    await source.db.executor.updateTable("ai_funded_global_policy").set({ enabled: true,
      allowed_model_ids: JSON.stringify(["anthropic/claude-sonnet-5"]), revision: 1, updated_at: new Date(PAIR_NOW).toISOString(),
    }).where("policy_id", "=", "default").execute();
    const funding = loadPreviewRuntimeAccessConfig({ MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true",
      MATRIX_PREVIEW_RUNTIME_SECRET: "r".repeat(48), PLATFORM_SECRET: controlSecret, MATRIX_PREVIEW_AI_BUDGET_MICROUSD: "1000" });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/api/internal/platform-funded-ai/config");
      expect(JSON.stringify(init)).not.toContain(controlSecret);
      return init?.method === "POST" ? Response.json({ status: "restarting" }, { status: 202 })
        : Response.json({ configured: false, configurationRevision: null });
    });
    const options: PreviewPairRuntimeOptions = { db: source.db, target: destination, config, context, controlSecret,
      hostSecret, dispatcher, fetchImpl, now: () => PAIR_NOW,
      authority: { source: proof.source, authority: async () => true, membership: async actor => actor !== "user_pair_outsider",
        isMaintainer: async actor => actor === "user_requester", verifyFixtures: async () => true,
        resolveController: async input => ({ ...input, requesterId: "user_requester", controllerSha: config.reviewedControllerSha }),
        inspectRequest: async () => ({ open: true, requested: true, sourceSha: proof.expected.sourceSha }) },
      funding: { config: funding, repository, relayOrigin: "https://matrix-ai-relay-production-fixture.a.run.app" }, retireCloud: async () => true };
    const runtime = createPreviewPairRuntime(options);
    const request = { repository: "HamedMP/matrix-os", pairId: proof.expected.pairId, pr: proof.expected.pr,
      sourceSha: proof.expected.sourceSha, controllerRunId: 42, candidate: proof.input };
    return { ...runtime, provider, request, fetchImpl, options };
  }
  it("dispatches each owner once and adopts actual candidate registrations without touching the customer", async () => {
    const s = await setup();
    const started = await s.service.start(s.request) as { pairId: string };
    async function reconcile() {
      const pair = await source.db.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", started.pairId).executeTakeFirstOrThrow();
      return s.service.action(pair.pair_id, { type: "reconcile", generation: pair.generation, revision: pair.revision });
    }
    const candidate = createPreviewPairRuntimeOnlyService({ db: target.db,
      env: { ...candidateRuntimeEnvironment(), PLATFORM_SECRET: hostSecret }, now: () => new Date(PAIR_NOW) });
    if (!candidate) throw new Error("Candidate runtime is required");
    for (let index = 1; index <= 2; index++) {
      await reconcile(); expect(s.provider.createServer).toHaveBeenCalledTimes(index);
      expect(await source.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
      const pending = await target.db.executor.selectFrom("user_machines").selectAll().where("status", "=", "provisioning")
        .where("hetzner_server_id", "is not", null).executeTakeFirstOrThrow();
      const job = await source.db.executor.selectFrom("provisioning_jobs").selectAll().where("machine_id", "=", pending.machine_id).executeTakeFirstOrThrow();
      expect(job.encrypted_payload).toBeNull(); // The real dispatcher clears consumed credentials.
      const boot = s.provider.createServer.mock.calls.at(-1)![0];
      expect(boot.labels?.machine_id).toBe(pending.machine_id);
      const token = /^\s*MATRIX_REGISTRATION_TOKEN=([^\s]+)$/m.exec(boot.userData)?.[1];
      if (!token) throw new Error("The real bootstrap registration token is required");
      await candidate.register(token, { machineId: pending.machine_id, hetznerServerId: Number(pending.hetzner_server_id),
        publicIPv4: pending.public_ipv4!, imageVersion: pending.target_bundle_version!, bundleSha256: pending.target_bundle_sha256!, healthy: true });
    }
    expect(await reconcile()).toMatchObject({ state: "preparing" }); // Host restart remains an explicit pending fixture.
    expect(await source.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toHaveLength(1);
    expect((await source.db.executor.selectFrom("user_machines").select("status").where("provisioning_class", "=", "preview").execute()).map(row => row.status)).toEqual(["running", "running"]);
    expect((await source.db.executor.selectFrom("provisioning_jobs").select("status").execute()).map(row => row.status)).toEqual(["completed", "completed"]);
    expect(s.provider.createServer).toHaveBeenCalledTimes(2);
    expect(await source.db.executor.selectFrom("user_machines").select(["status", "runtime_slot", "provisioning_class"]).where("machine_id", "=", "unrelated-customer").executeTakeFirstOrThrow())
      .toEqual({ status: "running", runtime_slot: "primary", provisioning_class: "customer" });
    expect(await target.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
    const customerDeletion = "99999999-9999-4999-8999-999999999999";
    await insertProviderDeletion(source.db, { id: customerDeletion, providerServerId: 999,
      reason: "rejected_snapshot_recovery_clone", machineId: "unrelated-customer", handle: "customer",
      nextAttemptAt: new Date(PAIR_NOW - 1_000).toISOString(), createdAt: new Date(PAIR_NOW).toISOString() });
    const pair = await source.db.executor.selectFrom("preview_pairs").selectAll().where("pair_id", "=", started.pairId).executeTakeFirstOrThrow();
    const pending = await s.service.action(pair.pair_id, { type: "stop", generation: 1, revision: pair.revision });
    expect(await s.service.action(pair.pair_id, { type: "reconcile", generation: 1, revision: pending.revision }))
      .toMatchObject({ state: "stopped" });
    expect(s.provider.deleteServer.mock.calls.map(call => call[0]).sort()).toEqual([801, 802]);
    expect((await source.db.executor.selectFrom("provider_deletion_queue").select("completed_at").where("id", "=", customerDeletion).executeTakeFirstOrThrow()).completed_at).toBeNull();
    expect((await source.db.executor.selectFrom("user_machines").select("status").where("machine_id", "=", "unrelated-customer").executeTakeFirstOrThrow()).status).toBe("running");
  });
  it("refuses a control-readable target before admitting or dispatching new computers", async () => {
    const s = await setup(source.db);
    await expect(s.service.start(s.request)).rejects.toThrow("unavailable");
    expect(s.provider.createServer).not.toHaveBeenCalled();
    expect(await source.db.executor.selectFrom("preview_pairs").selectAll().execute()).toEqual([]);
    expect(await source.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(1);
  });
  it("keeps retirement available with admissions and the test bank disabled", async () => {
    const s = await setup();
    const started = await s.service.start(s.request) as { pairId: string; revision: number };
    const maintenance = createPreviewPairRuntime({ ...s.options, config: { ...s.options.config, admissionEnabled: false },
      funding: { ...s.options.funding, config: { enabled: false } } });
    const pending = await maintenance.service.action(started.pairId, { type: "stop", generation: 1, revision: started.revision });
    expect(await maintenance.service.action(started.pairId, { type: "reconcile", generation: 1, revision: pending.revision }))
      .toMatchObject({ state: "stopped" });
    expect(await source.db.executor.selectFrom("ai_funded_credit_ledger").selectAll().execute()).toEqual([]);
    expect((await target.db.executor.selectFrom("user_machines").select("status").execute()).map(row => row.status)).toEqual(["deleted", "deleted"]);
    expect(s.provider.createServer).not.toHaveBeenCalled();
  });
  it("rejects new admissions without bank capability while retaining the service for cleanup", async () => {
    const s = await setup();
    const runtime = createPreviewPairRuntime({ ...s.options, funding: { ...s.options.funding, config: { enabled: false } } });
    await expect(runtime.service.start(s.request)).rejects.toMatchObject({ status: 503 });
    expect(await source.db.executor.selectFrom("preview_pairs").selectAll().execute()).toEqual([]);
    expect(s.provider.createServer).not.toHaveBeenCalled();
  });
});
