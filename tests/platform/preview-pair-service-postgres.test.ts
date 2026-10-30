import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { readyPreviewPair, previewPairReadinessAdapters } from "./preview-pair-ready-postgres.js";
import { previewPairProvenanceFixture } from "./preview-pair-provenance-fixture.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { createPreviewPairService } from "../../packages/platform/src/preview-pair/service.js";
import { createApp } from "../../packages/platform/src/main.js";
import { shutdownPlatformApp } from "../../packages/platform/src/shutdown-platform-app.js";
import { stubOrchestrator } from "./proxy-routing-test-utils.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("pair API service keeps controller authority and reader effects separate", () => {
  let fixture: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { fixture = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await fixture?.destroy(); });
  function setup(admissionEnabled = true) {
    const provenance = previewPairProvenanceFixture();
    provenance.input.hostBundleSha256 = fixture.candidate.hostBundleSha256;
    provenance.release.sha256 = fixture.candidate.hostBundleSha256;
    const controller = { runId: 42, controllerSha: fixture.config.reviewedControllerSha, requesterId: "user_requester",
      pairId: fixture.pair.pair_id, pr: fixture.pair.pr, generation: 1, sourceSha: fixture.pair.source_sha };
    const resolveController = vi.fn(async () => controller);
    const verifyFixtures = vi.fn(async () => true), activate = vi.fn(async () => false);
    const service = createPreviewPairService({ db: fixture.db, config: { ...fixture.config, admissionEnabled }, source: provenance.source,
      prepare: fixture.prepare, resolveController, verifyFixtures, activate,
      inspectRequest: async () => ({ open: true, requested: true, sourceSha: fixture.pair.source_sha }),
      isMaintainer: async actor => ["user_requester", "user_maintainer"].includes(actor),
      readiness: previewPairReadinessAdapters(fixture), cleanup: { retire: async () => undefined,
        proveAbsent: async member => ({ machineId: member.machineId, providerServerId: null, exactServerAbsent: true,
          labeledServerIds: [], creationSettled: true, observedAt: new Date(PAIR_NOW).toISOString() }) }, now: () => PAIR_NOW });
    const request = { repository: "HamedMP/matrix-os", pairId: fixture.pair.pair_id, pr: fixture.pair.pr,
      sourceSha: fixture.pair.source_sha, controllerRunId: 42, candidate: provenance.input };
    return { service, controller, resolveController, verifyFixtures, activate, request, provenance };
  }
  const reader = { kind: "control" as const, actorId: "user_requester", expiresAt: PAIR_NOW + 60_000 };
  it("maintenance denies new admissions and generation updates before controller or provider calls", async () => {
    const { service, request, resolveController, verifyFixtures } = setup(false);
    await expect(service.start(request)).rejects.toMatchObject({ status: 503 });
    await expect(service.action(fixture.pair.pair_id, { type: "update", generation: 1, revision: 1,
      dataPolicy: "reset", controllerRunId: 42, candidate: request.candidate })).rejects.toMatchObject({ status: 503 });
    expect(resolveController).not.toHaveBeenCalled(); expect(verifyFixtures).not.toHaveBeenCalled();
    expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("maintenance retains authenticated inspection and stop actions", async () => {
    const { service } = setup(false);
    expect(await service.report(fixture.pair.pair_id, reader)).toMatchObject({ pairId: fixture.pair.pair_id });
    expect(await service.action(fixture.pair.pair_id, { type: "stop", generation: 1, revision: 1 }))
      .toMatchObject({ state: "cleanup_pending" });
  });
  it("mounts real authenticated report routes when only maintenance is enabled", async () => {
    const { service, activate } = setup(false);
    const app = createApp({ db: fixture.db, orchestrator: stubOrchestrator(), platformSecret: "fixture-host-secret",
      env: { MATRIX_PREVIEW_PAIR_ENABLED: "false", MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED: "true" },
      previewPairs: { enabled: true, service, operatorSecret: "o".repeat(40), now: () => PAIR_NOW,
        authenticateReader: async request => request.headers.get("authorization") === "Bearer fixture-reader" ? reader : null } });
    try {
      const response = await app.request(`/api/preview-pairs/${fixture.pair.pair_id}`, { headers: { authorization: "Bearer fixture-reader" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pairId: fixture.pair.pair_id });
      expect((await app.request(`/api/preview-pairs/${fixture.pair.pair_id}`)).status).toBe(401);
      expect(activate).not.toHaveBeenCalled();
    } finally { await shutdownPlatformApp(app); }
  });
  it("verifies the controller and canonical candidate before converging without provider effects", async () => {
    const { service, request, resolveController, verifyFixtures, activate } = setup();
    expect(await service.start(request)).toMatchObject({ pairId: fixture.pair.pair_id, state: "preparing" });
    expect(resolveController).toHaveBeenCalled(); expect(verifyFixtures).toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled(); expect(fixture.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("rejects an unrelated controller source before candidate reads or writes", async () => {
    const { service, request, controller, provenance } = setup(); controller.sourceSha = "c".repeat(40);
    await expect(service.start(request)).rejects.toMatchObject({ status: 403 });
    expect(provenance.source.pullRequest).not.toHaveBeenCalled();
  });
  it("does not accept an unreviewed controller execution", async () => {
    const { service, request, controller } = setup(); controller.controllerSha = "c".repeat(40);
    await expect(service.start(request)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects unverified fixture inventory without allocating new machines", async () => {
    const { service, request, verifyFixtures } = setup(); verifyFixtures.mockResolvedValue(false);
    await expect(service.start(request)).rejects.toThrow("unavailable");
    expect(await fixture.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  });
  it("a reader cannot trigger infrastructure activation by requesting a manifest", async () => {
    const { service, activate } = setup();
    await expect(service.manifest(fixture.pair.pair_id, reader)).rejects.toThrow("unavailable");
    expect(activate).not.toHaveBeenCalled();
  });
  it("a ready manifest revalidates current canonical observations without provisioning", async () => {
    await readyPreviewPair(fixture); const { service, activate } = setup();
    expect(await service.manifest(fixture.pair.pair_id, reader)).toMatchObject({ pairId: fixture.pair.pair_id, state: "ready" });
    expect(activate).not.toHaveBeenCalled();
  });
  it("fixture actors can inspect their report but cannot list all pairs", async () => {
    const { service } = setup();
    const actor = { ...reader, actorId: "user_pair_owner", kind: "preview" as const };
    expect(await service.report(fixture.pair.pair_id, actor)).toMatchObject({ pairId: fixture.pair.pair_id });
    await expect(service.list({ limit: 16 }, actor)).rejects.toMatchObject({ status: 403 });
  });
  it("reconciles an active pair even with a full batch of older waiting pairs", async () => {
    for(let i=0;i<16;i++) await fixture.db.executor.insertInto("preview_pairs").values({
      pair_id:`22222222-2222-4222-8222-${String(i).padStart(12,"0")}`,repository:"HamedMP/matrix-os",pr:4000+i,
      requester_id:"user_requester",source_sha:fixture.pair.source_sha,state:"queued",
      created_at:new Date(PAIR_NOW-60_000).toISOString(),expires_at:fixture.pair.expires_at,
    }).execute();
    const {service,activate}=setup(); await service.reconcile({limit:16});
    expect(activate).toHaveBeenCalledOnce();
  });
  it("hard expiry bypasses a future scheduling backoff",async () => {
    await fixture.db.executor.updateTable("preview_pairs").set({expires_at:new Date(PAIR_NOW).toISOString(),created_at:new Date(PAIR_NOW-60_000).toISOString(),next_attempt_at:new Date(PAIR_NOW+300_000).toISOString()}).execute();
    const {service}=setup(); expect(await service.reconcile({limit:16})).toMatchObject({checked:1});
    expect((await fixture.db.executor.selectFrom("preview_pairs").select("state").executeTakeFirstOrThrow()).state).toBe("cleanup_pending");
  });
  it("stale operator actions cannot mutate the selected generation", async () => {
    const { service } = setup();
    await expect(service.action(fixture.pair.pair_id, { type: "stop", generation: 2, revision: 1 })).rejects.toThrow("unavailable");
    expect((await fixture.db.executor.selectFrom("preview_pairs").selectAll().executeTakeFirstOrThrow()).state).toBe("preparing");
  });
});
