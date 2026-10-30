import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { claimPreviewPair, requestPreviewPairStop } from "../../packages/platform/src/preview-pair/lifecycle.js";
import { createPreviewPairCloudCleanup } from "../../packages/platform/src/preview-pair/cleanup-cloud.js";
import { previewPairRevisionName } from "../../packages/platform/src/preview-pair/cloud-resource.js";
import { previewPairTag } from "@matrix-os/contracts/preview-pair";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("canonical pair Cloud Run retirement", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup() {
    const pending = await requestPreviewPairStop(f.db, f.pair.pair_id, 1, f.pair.revision, PAIR_NOW);
    const claim = await claimPreviewPair(f.db, pending.pair_id, 1, pending.revision, PAIR_NOW);
    const m = await f.db.executor.selectFrom("preview_pair_members").selectAll().where("role", "=", "owner").executeTakeFirstOrThrow();
    const member = { pairId: pending.pair_id, generation: 1, machineId: m.machine_id, actorId: m.actor_id,
      handle: m.handle, jobId: m.job_id, providerServerId: null };
    const resource = "projects/pair-test/locations/europe-west1/services/matrix-platform-preview";
    const revision = previewPairRevisionName("matrix-platform-preview", member.pairId, 1);
    const base = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "matrix-platform-preview-baseline", percent: 100 };
    const other = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: "matrix-platform-preview-other", tag: "unrelated-pair", percent: 0 };
    const owned = ["ui", "api"].map(kind => ({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision,
      tag: previewPairTag(member.pairId, 1, kind as "ui" | "api"), percent: 0 }));
    const service = { name: resource, etag: "service-v1", reconciling: false,
      traffic: [base, other, ...owned], trafficStatuses: [base, other, ...owned] };
    const env = [{ name: "MATRIX_PREVIEW_PAIR_ID", value: member.pairId }, { name: "MATRIX_PREVIEW_PAIR_GENERATION", value: "1" },
      { name: "MATRIX_BUILD_SHA", value: f.candidate.platformSource.sha }];
    const rev = { name: `${resource}/revisions/${revision}`, etag: "revision-v1", containers: [{ env }] };
    let absent = false, conflict = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://run.googleapis.com");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer iam-fixture");
      expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.redirect).toBe("error");
      if (init?.method === "PATCH") {
        if (conflict) return new Response(null, { status: 412 });
        const body = JSON.parse(String(init.body));
        expect(target.searchParams.get("updateMask")).toBe("traffic");
        expect(body).toEqual({ name: resource, etag: service.etag, traffic: [base, other] });
        service.traffic = body.traffic;
        return Response.json({ name: "operation-patch" });
      }
      if (init?.method === "DELETE") {
        expect(target.pathname).toBe(`/v2/${rev.name}`);
        expect(target.searchParams.get("etag")).toBe("revision-v1");
        absent = true; return Response.json({ name: "operation-delete" });
      }
      if (target.pathname === `/v2/${resource}`) return Response.json(service);
      expect(target.pathname).toBe(`/v2/${rev.name}`);
      return absent ? new Response(null, { status: 404 }) : Response.json(rev);
    });
    const retire = createPreviewPairCloudCleanup({ db: f.db, project: "pair-test", region: "europe-west1",
      service: "matrix-platform-preview", accessToken: async () => "iam-fixture", fetchImpl, now: () => PAIR_NOW });
    const signal = new AbortController().signal;
    return { claim, member, retire, fetchImpl, service, env, revision, base, other, signal, conflict: () => { conflict = true; } };
  }
  it("removes only exact zero-traffic tags, waits for observed removal, then confirms revision absence", async () => {
    const s = await setup();
    expect(await s.retire(s.member, s.claim, s.signal)).toBe(false);
    expect(s.service.traffic).toEqual([s.base, s.other]);
    expect(await s.retire(s.member, s.claim, s.signal)).toBe(false); // observed tags still present
    expect(s.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
    s.service.trafficStatuses = [s.base, s.other];
    expect(await s.retire(s.member, s.claim, s.signal)).toBe(false); // deletion acknowledgement
    expect(await s.retire(s.member, s.claim, s.signal)).toBe(true); // fresh404, not acknowledgement
    expect(s.fetchImpl.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(s.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("rejects another full pair sharing the short prefix before any mutation", async () => {
    const s = await setup();
    s.env[0].value = s.member.pairId.slice(0, -1) + (s.member.pairId.endsWith("1") ? "2" : "1");
    await expect(s.retire(s.member, s.claim, s.signal)).rejects.toThrow("unavailable");
    expect(s.fetchImpl.mock.calls.some(([, init]) => ["PATCH", "DELETE"].includes(init?.method ?? "GET"))).toBe(false);
  });
  it("does not retry an etag conflict in the same pass or treat it as cleanup completion", async () => {
    const s = await setup(); s.conflict();
    expect(await s.retire(s.member, s.claim, s.signal)).toBe(false);
    expect(s.fetchImpl.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(s.fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  });
  it("a stale canonical claim causes no provider request", async () => {
    const s = await setup();
    await expect(s.retire(s.member, { ...s.claim, revision: s.claim.revision + 1 }, s.signal)).rejects.toThrow("unavailable");
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["active pair traffic", "unrelated revision alias", "wrong source"])("does not mutate cloud resources with %s", async fault => {
    const s = await setup();
    if (fault === "active pair traffic") s.service.traffic[2].percent = 1;
    if (fault === "unrelated revision alias") s.other.revision = s.revision;
    if (fault === "wrong source") s.env.find(entry => entry.name === "MATRIX_BUILD_SHA")!.value = "d".repeat(40);
    await expect(s.retire(s.member, s.claim, s.signal)).rejects.toThrow("unavailable");
    expect(s.fetchImpl.mock.calls.some(([, init]) => ["PATCH", "DELETE"].includes(init?.method ?? "GET"))).toBe(false);
  });
  it("cancels unsuccessful cloud probe bodies before leaving cleanup pending", async () => {
    const s = await setup(), cancel = vi.fn();
    s.fetchImpl.mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel,
    }), { status: 503 }));
    await expect(s.retire(s.member, s.claim, s.signal)).rejects.toThrow("unavailable");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
