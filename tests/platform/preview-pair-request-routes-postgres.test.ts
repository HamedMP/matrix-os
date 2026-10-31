import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { previewPairReadinessAdapters } from "./preview-pair-ready-postgres.js";
import { previewPairProvenanceFixture } from "./preview-pair-provenance-fixture.js";
import { createPreviewPairService } from "../../packages/platform/src/preview-pair/service.js";
import { createPreviewPairRoutes } from "../../packages/platform/src/preview-pair/routes.js";
import type { PreviewPairPublisher } from "../../packages/platform/src/preview-pair/publication-contract.js";
import { claimPreviewPair } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { createPreviewPairControlClient } from "../../scripts/preview-pair/control-client.js";

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
    const isMaintainer = vi.fn(async (actor: string) => ["user_requester", "user_maintainer"].includes(actor)), inspectRequest = vi.fn(async () => request);
    const provenance = previewPairProvenanceFixture();
    const publication = { context: { imageRepository: "europe-west1-docker.pkg.dev/matrix-test/matrix-preview-pairs/matrix-platform",
      clerkPublishableKey: config.clerkPublishableKey }, publish: vi.fn<PreviewPairPublisher["publish"]>(async () => ({ ready: false, publication: "accepted" })),
      ready: vi.fn(async () => true) };
    const service = createPreviewPairService({ db: f.db, config, source: provenance.source, prepare: f.prepare,
      resolveController, verifyFixtures, isMaintainer, inspectRequest, now: () => PAIR_NOW,
      activate: async () => false, readiness: previewPairReadinessAdapters(f),
      ...{ publication }, cleanup: { retire: async () => undefined, proveAbsent: async member => ({ machineId: member.machineId,
        providerServerId: null, exactServerAbsent: true, labeledServerIds: [], creationSettled: true,
        observedAt: new Date(PAIR_NOW).toISOString() }) } });
    const app = createPreviewPairRoutes({ enabled: true, operatorSecret: "o".repeat(40), service, now: () => PAIR_NOW,
      authenticateReader: async req => {
        const token = req.headers.get("authorization");
        if (token === "Bearer reader-requester") return { kind: "control", actorId: "user_requester", expiresAt: PAIR_NOW + 60_000 };
        if (token === "Bearer reader-maintainer") return { kind: "control", actorId: "user_maintainer", expiresAt: PAIR_NOW + 60_000 };
        if (token === "Bearer reader-outsider") return { kind: "control", actorId: "user_other", expiresAt: PAIR_NOW + 60_000 };
        if (token === "Bearer reader-preview") return { kind: "preview", actorId: "user_requester", expiresAt: PAIR_NOW + 60_000 };
        if (token === "Bearer reader-expired") return { kind: "control", actorId: "user_requester", expiresAt: PAIR_NOW };
        return null;
      } });
    const post = (path = "/vps/preview-pairs/requests", value: unknown = input, token = "o".repeat(40)) =>
      app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
    const get = (path: string, token = "reader-requester") => app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { config, input, receipt, request, post, get, app, publication, resolveController, verifyFixtures, isMaintainer, inspectRequest, provenance };
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
  it("gives the real control maintainer only the approved controller and their verified requester identity", async () => {
    const s = setup(), response = await s.get("/api/preview-pairs/setup");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ controllerSha: s.config.reviewedControllerSha,
      controllerRef: `preview-pair-controller/${s.config.reviewedControllerSha}`, requesterId: "user_requester", admissionEnabled: true });
    expect(s.verifyFixtures).not.toHaveBeenCalled();
    expect(await f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().execute()).toEqual([]);
  });
  it("does not expose controller setup to an outsider, Preview identity, expired reader or operator bearer", async () => {
    const s = setup(), path = "/api/preview-pairs/setup";
    expect((await s.get(path, "reader-outsider")).status).toBe(403);
    expect((await s.get(path, "reader-preview")).status).toBe(403);
    expect((await s.get(path, "reader-expired")).status).toBe(401);
    expect((await s.get(path, "o".repeat(40))).status).toBe(401);
  });
  it("reuses an existing PR pair without granting the new controller cancellation ownership or creating another intent", async () => {
    const s = setup(); s.receipt.pr = f.pair.pr;
    const response = await s.post(undefined, { ...s.input, pr: f.pair.pr });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ kind: "pair", pairId: f.pair.pair_id, ownedRequest: false, state: "preparing" });
    expect(await f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().execute()).toEqual([]);
    expect(f.hetzner.createServer).not.toHaveBeenCalled();
  });
  it("lets only the recorded operator controller poll safe request and pair status", async () => {
    const s = setup(); expect((await s.post()).status).toBe(202);
    const path = `/vps/preview-pairs/${s.input.pairId}/status`;
    const input = { generation: 1, controllerRunId: 42 };
    const requested = await s.post(path, input);
    expect(requested.status).toBe(200);
    expect(await requested.json()).toMatchObject({ kind: "request", state: "prepared", publication: "unissued", infrastructureReady: false });
    expect((await s.post(path, { ...input, controllerRunId: 99 })).status).toBe(409);
    expect((await s.post(path, input, "reader-requester")).status).toBe(401);
    await f.db.executor.updateTable("preview_pair_generations").set({ controller_run_id: "42" }).execute();
    const paired = await s.post(`/vps/preview-pairs/${f.pair.pair_id}/status`, input);
    expect(paired.status).toBe(200);
    expect(await paired.json()).toMatchObject({ kind: "pair", pairId: f.pair.pair_id, generation: 1,
      currentGeneration: 1, revision: f.pair.revision, state: "preparing", infrastructureReady: false });
  });
  it("lets a current control maintainer stop one fenced generation without a workflow approval delay", async () => {
    const s = setup(), path = `/api/preview-pairs/${f.pair.pair_id}/stop`;
    const stop = (token: string, revision = f.pair.revision) => s.post(path, { generation: 1, revision }, token);
    expect((await stop("reader-outsider")).status).toBe(403);
    expect((await stop("reader-preview")).status).toBe(403);
    expect((await stop("reader-requester", f.pair.revision + 1)).status).toBe(409);
    expect((await s.post(path, { generation: 1, revision: f.pair.revision, padding: "x".repeat(17_000) }, "reader-requester")).status).toBe(413);
    expect((await stop("reader-requester")).status).toBe(200);
    expect((await f.db.executor.selectFrom("preview_pairs").select("state").executeTakeFirstOrThrow()).state).toBe("cleanup_pending");
    expect(f.hetzner.deleteServer).not.toHaveBeenCalled();
  });
  it("adopts the selected update once despite progress revisions, while rejecting a different parent source", async () => {
    const s = setup(), p = s.provenance;
    Object.assign(s.receipt, { pairId: f.pair.pair_id, generation: 2, pr: f.pair.pr });
    const candidate = { ...p.input, sourceProfileFingerprint: s.config.sourceProfileFingerprint,
      browserOrigin: p.input.browserOrigin.replace("g1", "g2"), apiOrigin: p.input.apiOrigin.replace("g1", "g2") };
    Object.assign(p.authority, { generation: 2, browserOrigin: candidate.browserOrigin, apiOrigin: candidate.apiOrigin,
      appDomainHosts: [new URL(candidate.browserOrigin).hostname] });
    expect((await s.post(undefined, { ...s.input, pairId: f.pair.pair_id, generation: 2, pr: f.pair.pr })).status).toBe(202);
    await claimPreviewPair(f.db, f.pair.pair_id, 1, f.pair.revision, PAIR_NOW);
    const path = `/vps/preview-pairs/${f.pair.pair_id}/adoption`;
    const input = { baseGeneration: 1, baseSourceSha: f.pair.source_sha, controllerRunId: 42, candidate };
    expect((await s.post(path, { ...input, baseSourceSha: "e".repeat(40) })).status).toBe(409);
    expect((await s.post(path, input)).status).toBe(202);
    expect((await f.db.executor.selectFrom("preview_pairs").select("state").executeTakeFirstOrThrow()).state).toBe("updating");
    expect((await s.post(path, input)).status).toBe(202);
    expect(await f.db.executor.selectFrom("preview_pair_generations").selectAll().execute()).toHaveLength(2);
    const status = await s.post(`/vps/preview-pairs/${f.pair.pair_id}/status`, { generation: 2, controllerRunId: 42 });
    expect(await status.json()).toMatchObject({ kind: "pair", generation: 2, currentGeneration: 1, state: "updating" });
    expect((await s.post(`/vps/preview-pairs/${f.pair.pair_id}/status`, { generation: 1, controllerRunId: 42 })).status).toBe(409);
  });
  it("runs the actual fixed-origin controller client against the production router without confusing operator and user credentials", async () => {
    const s = setup();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).origin).toBe("https://api.matrix-os.com");
      expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return s.app.request(new Request(url, init));
    });
    const reader = createPreviewPairControlClient({ origin: "https://api.matrix-os.com", token: "reader-requester", fetchImpl });
    const operator = createPreviewPairControlClient({ origin: "https://api.matrix-os.com", token: "o".repeat(40), fetchImpl });
    expect((await reader.setup()).requesterId).toBe("user_requester");
    await expect(reader.prepare(s.receipt)).rejects.toMatchObject({ status: 401 });
    const prepared = await operator.prepare(s.receipt); expect(prepared.kind).toBe("request");
    expect(await operator.status(s.receipt)).toMatchObject({ kind: "request", state: "prepared" });
    await operator.stopOwned(s.receipt);
    expect(await reader.report(s.input.pairId)).toMatchObject({ kind: "request", state: "cleanup_pending" });
    const before = fetchImpl.mock.calls.length;
    expect(() => createPreviewPairControlClient({ origin: "https://candidate.invalid", token: "reader-requester", fetchImpl })).toThrow("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(before);
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
  it("lets the verified requester inspect a failed setup before a pair or machine exists", async () => {
    const s = setup(); expect((await s.post()).status).toBe(202);
    const response = await s.get(`/api/preview-pairs/${s.input.pairId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "request", pairId: s.input.pairId, generation: 1,
      state: "prepared", publication: "unissued", infrastructureReady: false, acceptance: "not_run", members: [] });
    expect((await s.get(`/api/preview-pairs/${s.input.pairId}/manifest`)).status).toBe(404);
  });
  it("serves an exact-generation safe diagnostic to a current maintainer and suppresses private provider fields", async () => {
    const s = setup(); expect((await s.post()).status).toBe(202);
    await f.db.executor.updateTable("preview_pair_cloud_intents").set({ failure_code: "private provider error /operator/path",
      publication_id: "55555555-5555-4555-8555-555555555555", publication_state: "accepted",
      operation_name: "projects/private-test/locations/test/operations/private-reference" }).where("pair_id", "=", s.input.pairId).execute();
    const response = await s.get(`/api/preview-pairs/${s.input.pairId}/requests/1`, "reader-maintainer");
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({ kind: "request", failedStage: "unavailable", infrastructureReady: false });
    expect(JSON.stringify(report)).not.toMatch(/operator\/path|private-reference|55555555|claim_id|operation_name/);
  });
  it("does not turn a report into Preview-issuer, outsider or expired-session access", async () => {
    const s = setup(); expect((await s.post()).status).toBe(202);
    const path = `/api/preview-pairs/${s.input.pairId}/requests/1`;
    expect((await s.get(path, "reader-outsider")).status).toBe(404);
    expect((await s.get(path, "reader-preview")).status).toBe(404);
    expect((await s.get(path, "reader-expired")).status).toBe(401);
    expect((await s.get(`/api/preview-pairs/${s.input.pairId}`, "reader-outsider")).status).toBe(404);
    expect((await s.get(path.replace("/1", "/0"))).status).toBe(400);
    expect((await s.get(path.replace("/1", "/1000"))).status).toBe(400);
  });
  it("reauthorizes the exact request before invoking the private source publisher", async () => {
    const s = setup(); expect((await s.post()).status).toBe(202);
    const path = `/vps/preview-pairs/requests/${s.input.pairId}/publication`;
    const response = await s.post(path, { generation: 1, controllerRunId: 42, imageSha256: "e".repeat(64) });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ready: false, publication: "accepted" });
    expect(s.resolveController).toHaveBeenCalledTimes(2); expect(s.verifyFixtures).toHaveBeenCalledTimes(2);
    expect(s.publication.publish).toHaveBeenCalledOnce();
    expect(s.publication.publish.mock.calls[0]).toEqual([expect.objectContaining({ pairId: s.input.pairId, generation: 1,
      pr: 3023, requesterId: "user_requester", controllerRunId: 42, sourceSha: s.input.sourceSha, imageSha256: "e".repeat(64) }), expect.any(AbortSignal)]);
  });
  it("a cancelled request or caller-selected publication target cannot reach the publisher", async () => {
    const s = setup(); expect((await s.post()).status).toBe(202);
    const path = `/vps/preview-pairs/requests/${s.input.pairId}/publication`;
    const body = { generation: 1, controllerRunId: 42, imageSha256: "e".repeat(64) };
    expect((await s.post(path, body, "wrong")).status).toBe(401);
    expect((await s.post(path, { ...body, imageUrl: "https://untrusted.test/image" })).status).toBe(400);
    await s.post(`/vps/preview-pairs/requests/${s.input.pairId}/actions`, { type: "stop", generation: 1, controllerRunId: 42 });
    expect((await s.post(path, body)).status).toBe(409);
    expect(s.publication.publish).not.toHaveBeenCalled();
  });
});
