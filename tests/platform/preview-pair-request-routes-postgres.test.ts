import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { previewPairReadinessAdapters } from "./preview-pair-ready-postgres.js";
import { previewPairProvenanceFixture } from "./preview-pair-provenance-fixture.js";
import { createPreviewPairService } from "../../packages/platform/src/preview-pair/service.js";
import { createPreviewPairRoutes } from "../../packages/platform/src/preview-pair/routes.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("trusted pre-publication request routes", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  function setup() {
    const config = { ...f.config, sourceProfileFingerprint: "f".repeat(64) };
    const input = { repository: "HamedMP/matrix-os", pairId: "44444444-4444-4444-8444-444444444444",
      generation: 1, pr: 3023, sourceSha: f.pair.source_sha, controllerRunId: 42 };
    const receipt = { runId: 42, controllerSha: config.reviewedControllerSha, requesterId: "user_requester",
      pairId: input.pairId, generation: 1, pr: 3023, sourceSha: input.sourceSha };
    const request = { open: true, requested: true, sourceSha: input.sourceSha };
    const resolveController = vi.fn(async () => receipt), verifyFixtures = vi.fn(async () => true);
    const isMaintainer = vi.fn(async () => true), inspectRequest = vi.fn(async () => request);
    const provenance = previewPairProvenanceFixture();
    const service = createPreviewPairService({ db: f.db, config, source: provenance.source, prepare: f.prepare,
      resolveController, verifyFixtures, isMaintainer, inspectRequest, now: () => PAIR_NOW,
      activate: async () => false, readiness: previewPairReadinessAdapters(f),
      cleanup: { retire: async () => undefined, proveAbsent: async member => ({ machineId: member.machineId,
        providerServerId: null, exactServerAbsent: true, labeledServerIds: [], creationSettled: true,
        observedAt: new Date(PAIR_NOW).toISOString() }) } });
    const app = createPreviewPairRoutes({ enabled: true, operatorSecret: "o".repeat(40), service });
    const post = (path = "/vps/preview-pairs/requests", value: unknown = input, token = "o".repeat(40)) =>
      app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
    return { config, input, receipt, request, post, resolveController, verifyFixtures, isMaintainer, inspectRequest, provenance };
  }
  it("persists a verified intent before any candidate or VPS provider read", async () => {
    const s = setup(), response = await s.post();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ pairId: s.input.pairId, generation: 1, state: "prepared" });
    expect(s.resolveController).toHaveBeenCalled(); expect(s.verifyFixtures).toHaveBeenCalled(); expect(s.inspectRequest).toHaveBeenCalled();
    expect(s.provenance.source.authority).not.toHaveBeenCalled(); expect(f.hetzner.createServer).not.toHaveBeenCalled();
    expect(await f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().execute()).toHaveLength(1);
    expect(await f.db.executor.selectFrom("user_machines").selectAll().execute()).toHaveLength(2);
  });
  it.each(["controller", "maintainer", "isolation", "closed", "removed", "head"])("rejects %s before publication authority exists", async fault => {
    const s = setup();
    if (fault === "controller") s.receipt.controllerSha = "e".repeat(40);
    if (fault === "maintainer") s.isMaintainer.mockResolvedValue(false);
    if (fault === "isolation") s.verifyFixtures.mockResolvedValue(false);
    if (fault === "closed") s.request.open = false;
    if (fault === "removed") s.request.requested = false;
    if (fault === "head") s.request.sourceSha = "e".repeat(40);
    expect([403, 409, 503]).toContain((await s.post()).status);
    expect(await f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().execute()).toHaveLength(0);
  });
  it("requires the operator and excludes caller-selected issuer/profile/actor fields", async () => {
    const s = setup();
    expect((await s.post(undefined, undefined, "wrong")).status).toBe(401);
    expect((await s.post(undefined, { ...s.input, requesterId: "user_other" })).status).toBe(400);
    expect((await s.post(undefined, { ...s.input, profileFingerprint: "e".repeat(64) })).status).toBe(400);
    expect(s.resolveController).not.toHaveBeenCalled();
  });
  it("makes cancellation durable without letting another controller cancel it", async () => {
    const s = setup(); expect((await s.post()).status).toBe(202);
    const path = `/vps/preview-pairs/requests/${s.input.pairId}/actions`;
    expect((await s.post(path, { type: "stop", generation: 1, controllerRunId: 43 })).status).toBe(409);
    const stopped = await s.post(path, { type: "stop", generation: 1, controllerRunId: 42 });
    expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ state: "cleanup_pending" });
    expect((await s.post()).status).toBe(409);
  });
});
