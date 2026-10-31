import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeededPreviewPair } from "./preview-pair-seeded-postgres.js";
import { createPreviewPairSourceFixture } from "./preview-pair-source-fixture.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { loadPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { loadPreviewPairSourceProfile, previewPairSourceFingerprint } from "../../packages/platform/src/preview-pair/source-profile.js";
import { preparePreviewPairCloudIntent, stopPreviewPairCloudIntent } from "../../packages/platform/src/preview-pair/cloud-intents.js";
import { createPreviewPairPublisher } from "../../packages/platform/src/preview-pair/publication.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("source-owned single-effect publication", () => {
  let f: Awaited<ReturnType<typeof createSeededPreviewPair>>;
  beforeEach(async () => { f = await createSeededPreviewPair(); }, 30_000);
  afterEach(async () => { await f?.destroy(); });
  async function setup() {
    const fixture = createPreviewPairSourceFixture();
    fixture.env.MATRIX_PREVIEW_PAIR_SOURCE_PROFILE = JSON.stringify({ ...fixture.profile, imageRepository: "matrix-preview-pairs" });
    const loaded = loadPreviewPairConfig(fixture.env); if (!loaded.enabled) throw new Error("Enabled fixture required");
    const profile = loadPreviewPairSourceProfile(fixture.env, loaded)!;
    const config = { ...loaded, sourceProfileFingerprint: previewPairSourceFingerprint(profile, loaded) };
    const identity = { pairId: "44444444-4444-4444-8444-444444444444", generation: 1, pr: 3023,
      requesterId: "user_requester", sourceSha: f.pair.source_sha, controllerRunId: 42, profileFingerprint: config.sourceProfileFingerprint };
    await preparePreviewPairCloudIntent(f.db, config, identity, PAIR_NOW);
    const input = { ...identity, imageSha256: "e".repeat(64) }, resource = `projects/${profile.project}/locations/${profile.region}/services/${profile.service}`;
    const image = `${profile.region}-docker.pkg.dev/${profile.project}/${profile.imageRepository}/matrix-platform@sha256:${input.imageSha256}`;
    const base = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 };
    const service: Record<string, any> = { name: resource, etag: "v1", generation: "7", observedGeneration: "7", reconciling: false,
      terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" }, uri: "https://matrix-platform-preview-test.a.run.app",
      latestReadyRevision: `${resource}/revisions/${profile.service}-baseline`, traffic: [base],
      trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", percent: 100, revision: `${profile.service}-baseline` }] };
    const operation = { name: `projects/${profile.project}/locations/${profile.region}/operations/publication-test`, done: false };
    let template: any, patchStatus = 200, loseReply = false, discoverable = false, cancelDuringPatch = false, wrongImage = false;
    const saved = () => f.db.executor.selectFrom("preview_pair_cloud_intents").selectAll().where("pair_id", "=", input.pairId).executeTakeFirstOrThrow();
    const fetchImpl = vi.fn<typeof fetch>(async (target, init) => {
      const url = new URL(String(target));
      expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer iam-fixture");
      if (url.origin === "https://artifactregistry.googleapis.com") {
        return Response.json({ name: `projects/${profile.project}/locations/${profile.region}/repositories/${profile.imageRepository}/dockerImages/matrix-platform@sha256:${input.imageSha256}`, uri: image });
      }
      expect(url.origin).toBe("https://run.googleapis.com");
      if (init?.method === "PATCH") {
        expect(f.db.executor.isTransaction).toBe(false);
        const row = await saved(); expect(row).toMatchObject({ publication_state: "issuing", image_sha256: input.imageSha256 });
        expect(row.publication_id).not.toBeNull();
        if (patchStatus >= 400 && patchStatus < 500) return new Response(null, { status: patchStatus });
        const body = JSON.parse(String(init.body)); template = body.template;
        expect(template.containers[0].env.find((entry: any) => entry.name === "MATRIX_PREVIEW_PAIR_PUBLICATION_ID").value).toBe(row.publication_id);
        service.traffic = body.traffic; service.etag = "v2";
        service.trafficStatuses = body.traffic.map((entry: any) => ({ ...entry, uri: entry.tag
          ? `https://${entry.tag}---matrix-platform-preview-test.a.run.app` : service.uri }));
        if (cancelDuringPatch) await stopPreviewPairCloudIntent(f.db, input.pairId, 1, 42, PAIR_NOW);
        if (loseReply) throw new TypeError("simulated lost publication response");
        return patchStatus === 200 ? Response.json(operation) : new Response(null, { status: patchStatus });
      }
      if (url.pathname === `/v2/${operation.name}`) return Response.json(operation);
      if (url.pathname.endsWith("/operations")) return Response.json({ operations: discoverable && template
        ? [{ ...operation, metadata: { "@type": "type.googleapis.com/google.cloud.run.v2.Service", name: resource, template } }] : [] });
      if (url.pathname === `/v2/${resource}`) return Response.json(service);
      if (url.pathname.includes("/revisions/")) return template ? Response.json({ name: url.pathname.slice(4), service: resource,
        conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }], ...template,
        containers: template.containers.map((container: any) => ({ ...container, image: wrongImage ? image.replace(input.imageSha256, "d".repeat(64)) : container.image })) }) : new Response(null, { status: 404 });
      throw new Error("Unexpected provider endpoint");
    });
    const publisher = createPreviewPairPublisher({ db: f.db, config, profile, accessToken: async () => "iam-fixture", fetchImpl, now: () => PAIR_NOW });
    if (!publisher) throw new Error("Configured publisher required");
    const patches = () => fetchImpl.mock.calls.filter(([, init]) => init?.method === "PATCH");
    return { publisher, input, identity, profile, config, fetchImpl, saved, patches, operation, service,
      mode: (options: { status?: number; loseReply?: boolean; discoverable?: boolean; cancel?: boolean; wrongImage?: boolean }) => {
        patchStatus = options.status ?? 200; loseReply = options.loseReply ?? false; discoverable = options.discoverable ?? false;
        cancelDuringPatch = options.cancel ?? false; wrongImage = options.wrongImage ?? false;
      } };
  }
  it("journals before its one effect and only becomes ready after successful operation and immutable-image proof", async () => {
    const s = await setup();
    expect(await s.publisher.publish(s.input, AbortSignal.timeout(5000))).toMatchObject({ publication: "accepted", ready: false });
    expect(s.patches()).toHaveLength(1);
    expect(await s.publisher.ready(s.identity, AbortSignal.timeout(5000))).toBe(false);
    s.operation.done = true;
    expect(await s.publisher.publish(s.input, AbortSignal.timeout(5000))).toMatchObject({ publication: "accepted", ready: true });
    expect(s.patches()).toHaveLength(1);
  });
  it("concurrent publishers cannot reserve a second create", async () => {
    const s = await setup(); const outcomes = await Promise.allSettled([s.publisher.publish(s.input, AbortSignal.timeout(5000)),
      s.publisher.publish(s.input, AbortSignal.timeout(5000))]);
    expect(outcomes.some(result => result.status === "fulfilled")).toBe(true); expect(s.patches()).toHaveLength(1);
  });
  it("classifies malformed provider data as unavailable without issuing a mutation", async () => {
    const s = await setup(); s.fetchImpl.mockImplementationOnce(async () => Response.json({}));
    await expect(s.publisher.publish(s.input, AbortSignal.timeout(5000))).rejects.toThrow("Preview upstream is unavailable");
    expect(s.patches()).toHaveLength(0); expect((await s.saved()).publication_state).toBe("unissued");
  });
  it("provider success for another image cannot authorize adoption", async () => {
    const s = await setup(); await s.publisher.publish(s.input, AbortSignal.timeout(5000));
    s.operation.done = true; s.mode({ wrongImage: true });
    await expect(s.publisher.ready(s.identity, AbortSignal.timeout(5000))).rejects.toThrow("unavailable");
    expect(s.patches()).toHaveLength(1);
    await expect(s.publisher.publish({ ...s.input, imageSha256: "d".repeat(64) }, AbortSignal.timeout(5000))).rejects.toThrow("unavailable");
    expect(s.patches()).toHaveLength(1);
  });
  it("an ambiguous response never triggers a repeated effect and can recover its exact provider receipt", async () => {
    const s = await setup(); s.mode({ loseReply: true });
    await expect(s.publisher.publish(s.input, AbortSignal.timeout(5000))).rejects.toThrow();
    expect((await s.saved()).publication_state).toBe("issuing");
    expect(await s.publisher.publish(s.input, AbortSignal.timeout(5000))).toMatchObject({ publication: "issuing", ready: false });
    s.mode({ discoverable: true }); s.operation.done = true;
    expect(await s.publisher.publish(s.input, AbortSignal.timeout(5000))).toMatchObject({ publication: "accepted", ready: true });
    expect(s.patches()).toHaveLength(1);
  });
  it.each([403, 412, 503])("records status%s conservatively without retrying the effect", async status => {
    const s = await setup(); s.mode({ status });
    await expect(s.publisher.publish(s.input, AbortSignal.timeout(5000))).rejects.toThrow();
    expect((await s.saved()).publication_state).toBe(status < 500 ? "rejected" : "issuing");
    await s.publisher.publish(s.input, AbortSignal.timeout(5000)); expect(s.patches()).toHaveLength(1);
  });
  it("a cancelled request cannot create, and cancellation during a create retains its receipt", async () => {
    const s = await setup(); s.mode({ cancel: true });
    await s.publisher.publish(s.input, AbortSignal.timeout(5000));
    expect(await s.saved()).toMatchObject({ state: "cleanup_pending", publication_state: "accepted", operation_name: s.operation.name });
    await expect(s.publisher.publish(s.input, AbortSignal.timeout(5000))).rejects.toThrow("unavailable");
    expect(s.patches()).toHaveLength(1);
  });
});
