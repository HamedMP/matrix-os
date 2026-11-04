import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { preparePreviewPairCloudIntent, stopPreviewPairCloudIntent } from "../../packages/platform/src/preview-pair/cloud-intents.js";
import { createPreviewPairIntentRecovery } from "../../packages/platform/src/preview-pair/intent-recovery.js";
import { createPreviewPairIntentCloudCleanup } from "../../packages/platform/src/preview-pair/intent-cloud.js";
import { previewPairRevisionName } from "../../packages/platform/src/preview-pair/cloud-resource.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("source-owned orphan operation recovery", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup(state: "issuing" | "accepted" = "accepted") {
    let now = PAIR_NOW;
    const fingerprint = "f".repeat(64), pairId = "44444444-4444-4444-8444-444444444444";
    const publicationId = "55555555-5555-4555-8555-555555555555";
    await preparePreviewPairCloudIntent(f.db, { ...f.config, sourceProfileFingerprint: fingerprint }, {
      pairId, generation: 1, pr: 3023, requesterId: "user_requester", sourceSha: f.pair.source_sha,
      controllerRunId: 42, profileFingerprint: fingerprint }, now);
    const parent = "projects/pair-test/locations/europe-west1", resource = `${parent}/services/matrix-platform-preview`;
    const operation = { name: `${parent}/operations/publication-test`, done: true };
    await f.db.executor.updateTable("preview_pair_cloud_intents").set({ publication_state: state,
      publication_id: publicationId, operation_name: state === "accepted" ? operation.name : null }).where("pair_id", "=", pairId).execute();
    await stopPreviewPairCloudIntent(f.db, pairId, 1, 42, now);
    const revision = previewPairRevisionName("matrix-platform-preview", pairId, 1);
    const env = [{ name: "MATRIX_PREVIEW_PAIR_ID", value: pairId }, { name: "MATRIX_PREVIEW_PAIR_GENERATION", value: "1" },
      { name: "MATRIX_BUILD_SHA", value: f.pair.source_sha }, { name: "MATRIX_PREVIEW_PAIR_PUBLICATION_ID", value: publicationId }];
    const metadata = { "@type": "type.googleapis.com/google.cloud.run.v2.Service", name: resource,
      template: { revision, containers: [{ env }] } };
    let status = 200;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://run.googleapis.com"); expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer iam-fixture");
      if (url.pathname === `/v2/${operation.name}`) return status === 200 ? Response.json(operation) : new Response(null, { status });
      if (url.pathname === `/v2/${parent}/operations`) return Response.json({ operations: [] });
      expect(url.pathname).toBe(`/v2/${resource}`);
      return new Response(null, { status: 404 });
    });
    const accessToken = vi.fn(async () => "iam-fixture");
    const retire = createPreviewPairIntentCloudCleanup({ db: f.db, project: "pair-test", region: "europe-west1",
      service: "matrix-platform-preview", profileFingerprint: fingerprint, now: () => now, accessToken, fetchImpl });
    const inspectRequest = async () => ({ open: true, requested: true, sourceSha: f.pair.source_sha });
    const recover = createPreviewPairIntentRecovery({ db: f.db, admissionEnabled: true, profileFingerprint: fingerprint, now: () => now, inspectRequest, retire });
    const saved = () => f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", pairId).executeTakeFirstOrThrow();
    return { recover, retire, saved, fetchImpl, accessToken, operation, metadata, env, resource, parent, fingerprint,
      pairId, publicationId, inspectRequest, status: (value: number) => { status = value; },
      advance: (ms = 300_001) => { now += ms; }, now: () => now };
  }
  it("waits for a recorded operation to finish before trusting an otherwise missing service", async () => {
    const s = await setup(); s.operation.done = false;
    await s.recover(1);
    expect((await s.saved()).state).toBe("cleanup_pending");
    expect(s.fetchImpl).toHaveBeenCalledOnce();
    s.operation.done = true; s.advance(); await s.recover(1);
    expect((await s.saved()).state).toBe("stopped");
  });
  it.each([404, 503])("operation status%s is unknown, not absence", async status => {
    const s = await setup(); s.status(status); await s.recover(1);
    expect((await s.saved()).state).toBe("cleanup_pending");
    expect(s.fetchImpl).toHaveBeenCalledOnce();
  });
  it("cancels a failed operation response body while retaining the unresolved request", async () => {
    const s = await setup(), cancel = vi.fn();
    s.fetchImpl.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel,
    }), { status: 503 }));
    await s.recover(1);
    expect((await s.saved()).state).toBe("cleanup_pending");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("holds ambiguous publication without a receipt instead of treating an empty operation list as failure", async () => {
    const s = await setup("issuing"); await s.recover(1);
    expect(await s.saved()).toMatchObject({ state: "cleanup_pending", publication_state: "issuing", operation_name: null });
    expect(s.fetchImpl).toHaveBeenCalledOnce();
  });
  it("recovers a lost receipt from complete provider pages and resumes under a fresh claim", async () => {
    const s = await setup("issuing");
    s.fetchImpl.mockImplementation(async (input, init) => {
      const url = new URL(String(input)); expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.pathname === `/v2/${s.parent}/operations`) {
        return url.searchParams.has("pageToken") ? Response.json({ operations: [{ ...s.operation, metadata: s.metadata }] })
          : Response.json({ operations: [], nextPageToken: "next-page" });
      }
      if (url.pathname === `/v2/${s.operation.name}`) return Response.json(s.operation);
      expect(url.pathname).toBe(`/v2/${s.resource}`); return new Response(null, { status: 404 });
    });
    await s.recover(1);
    expect(await s.saved()).toMatchObject({ state: "cleanup_pending", publication_state: "accepted", operation_name: s.operation.name,
      claim_id: null, claim_expires_at: null });
    expect(s.fetchImpl).toHaveBeenCalledTimes(2);
    s.advance(); await s.recover(1); expect((await s.saved()).state).toBe("stopped");
  });
  it.each(["full UUID", "publication", "source", "resource"])("does not recover an operation with a different %s binding", async fault => {
    const s = await setup("issuing");
    if (fault === "full UUID") s.env[0].value = s.pairId.slice(0, -1) + "5";
    if (fault === "publication") s.env[3].value = "66666666-6666-4666-8666-666666666666";
    if (fault === "source") s.env[2].value = "e".repeat(40);
    if (fault === "resource") s.metadata.name = s.resource + "-other";
    s.fetchImpl.mockResolvedValue(Response.json({ operations: [{ ...s.operation, metadata: s.metadata }] }));
    await s.recover(1);
    expect(await s.saved()).toMatchObject({ state: "cleanup_pending", publication_state: "issuing", operation_name: null });
    expect(s.fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(["duplicate", "unreachable", "repeated page"])("incomplete or ambiguous provider discovery (%s) retains the request", async fault => {
    const s = await setup("issuing"), match = { ...s.operation, metadata: s.metadata };
    s.fetchImpl.mockImplementation(async () => Response.json(fault === "duplicate"
      ? { operations: [match, { ...match, name: match.name + "-duplicate" }] }
      : fault === "unreachable" ? { operations: [match], unreachable: ["unreachable-region"] }
        : { operations: [], nextPageToken: "same-page" }));
    await s.recover(1);
    expect(await s.saved()).toMatchObject({ state: "cleanup_pending", publication_state: "issuing", operation_name: null });
    expect(s.fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("does not let a profile change reinterpret another resource's404 as retirement", async () => {
    const s = await setup();
    const wrong = createPreviewPairIntentRecovery({ db: f.db, admissionEnabled: true, profileFingerprint: "e".repeat(64), now: s.now,
      inspectRequest: s.inspectRequest, retire: s.retire });
    await wrong(1);
    expect(await s.saved()).toMatchObject({ state: "cleanup_pending", failure_code: "authority" });
    expect(s.accessToken).not.toHaveBeenCalled(); expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it("an obsolete claim cannot confirm cleanup after a different worker takes over", async () => {
    const s = await setup(); let reassigned = false;
    s.fetchImpl.mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === `/v2/${s.operation.name}`) return Response.json(s.operation);
      expect(url.pathname).toBe(`/v2/${s.resource}`);
      if (!reassigned) {
        reassigned = true; s.advance(121_000);
        const other = createPreviewPairIntentRecovery({ db: f.db, admissionEnabled: true, profileFingerprint: s.fingerprint, now: s.now,
          inspectRequest: s.inspectRequest, retire: async () => false });
        await other(1);
      }
      return new Response(null, { status: 404 });
    });
    await s.recover(1);
    expect((await s.saved()).state).toBe("cleanup_pending");
    expect(s.fetchImpl.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});
