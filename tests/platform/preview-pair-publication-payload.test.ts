import { describe, expect, it, vi } from "vitest";
import { createPreviewPairSourceFixture } from "./preview-pair-source-fixture.js";
import { loadPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { loadPreviewPairSourceProfile } from "../../packages/platform/src/preview-pair/source-profile.js";
import { loadPreviewPairCandidateRuntimeProfile } from "../../packages/platform/src/preview-pair/candidate-profile.js";
import { buildPreviewPairPublication } from "../../packages/platform/src/preview-pair/publication-payload.js";
import { createPreviewPairCloudAuthority } from "../../packages/platform/src/preview-pair/cloud.js";

function setup() {
  const fixture = createPreviewPairSourceFixture();
  fixture.env.MATRIX_PREVIEW_PAIR_SOURCE_PROFILE = JSON.stringify({ ...fixture.profile, imageRepository: "matrix-preview-pairs" });
  const config = loadPreviewPairConfig(fixture.env);
  if (!config.enabled) throw new Error("Enabled fixture required");
  const profile = loadPreviewPairSourceProfile(fixture.env, config)!;
  const input = { pairId: "44444444-4444-4444-8444-444444444444", generation: 1, pr: 3023,
    sourceSha: "a".repeat(40), publicationId: "55555555-5555-4555-8555-555555555555" };
  const name = `projects/${profile.project}/locations/${profile.region}/services/${profile.service}`;
  const latest = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent: 100 };
  const other = { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: `${profile.service}-other`, tag: "other-preview", percent: 0 };
  const service = { name, etag: "service-v1", generation: "7", observedGeneration: "7", reconciling: false,
    terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" },
    latestReadyRevision: `${name}/revisions/${profile.service}-baseline`, uri: "https://matrix-platform-preview-test.a.run.app",
    traffic: [latest, other], trafficStatuses: [{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", percent: 100,
      revision: `${profile.service}-baseline` }, other],
    template: { containers: [{ env: [{ name: "HETZNER_API_TOKEN", value: "source-only-never-copy" }] }] } };
  const image = `europe-west1-docker.pkg.dev/matrix-test/matrix-preview-pairs/matrix-platform@sha256:${"e".repeat(64)}`;
  const build = () => buildPreviewPairPublication(service, { input, image, profile, config });
  return { fixture, config, profile, input, service, latest, other, image, build };
}

describe("actual candidate publication payload producer", () => {
  it("pins existing LATEST traffic before adding two zero-percent candidate tags", () => {
    const s = setup(), { body } = s.build();
    expect(body.name).toBe(s.service.name); expect(body.etag).toBe("service-v1");
    expect(body.traffic).toEqual([{ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", revision: `${s.profile.service}-baseline`, percent: 100 },
      s.other, expect.objectContaining({ tag: "cp-44444444-g1-ui", percent: 0 }), expect.objectContaining({ tag: "cp-44444444-g1-api", percent: 0 })]);
    expect(s.service.traffic[0]).toBe(s.latest);
  });
  it("feeds the real runtime-only profile consumer and never inherits source credentials", () => {
    const s = setup(), { body, browserOrigin, apiOrigin } = s.build();
    const entries = body.template.containers[0]!.env;
    const env = Object.fromEntries(entries.map(entry => [entry.name, "value" in entry ? entry.value
      : s.fixture.credentials[entry.name as keyof typeof s.fixture.credentials]]));
    expect(loadPreviewPairCandidateRuntimeProfile(env)).toMatchObject({ pairId: s.input.pairId,
      generation: 1, pr: 3023, apiOrigin });
    expect(env.MATRIX_APP_DOMAIN_HOSTS).toBe(new URL(browserOrigin).hostname);
    expect(entries.filter(entry => "valueSource" in entry)).toHaveLength(6);
    expect(JSON.stringify(body)).not.toMatch(/source-only-never-copy|operatorSecret|GITHUB_TOKEN|HETZNER_API_TOKEN|GOOGLE_APPLICATION_CREDENTIALS/);
    for (const secret of [...Object.values(s.fixture.credentials), s.fixture.env.MATRIX_PREVIEW_PAIR_OPERATOR_SECRET, s.fixture.env.PLATFORM_SECRET]) {
      expect(JSON.stringify(body)).not.toContain(secret);
    }
    expect(body.template.serviceAccount).toBe(s.config.serviceAccount);
  });
  it("lets the real cloud authority consumer verify the exact selected image and secret bindings", async () => {
    const s = setup(), built = s.build(), resource = s.service.name;
    const live = { ...s.service, trafficStatuses: built.body.traffic.map(entry => ({ ...entry,
      uri: entry.tag === "cp-44444444-g1-ui" ? built.browserOrigin : entry.tag === "cp-44444444-g1-api" ? built.apiOrigin : undefined })) };
    const revision = { name: `${resource}/revisions/${built.body.template.revision}`, service: resource,
      conditions: [{ type: "Ready", state: "CONDITION_SUCCEEDED" }], ...built.body.template };
    const fetchImpl = vi.fn<typeof fetch>(async input => Response.json(String(input).includes("/revisions/") ? revision : live));
    const authority = createPreviewPairCloudAuthority({ config: s.config, project: s.profile.project, region: s.profile.region,
      service: s.profile.service, approvedSecretRefs: Object.values(s.profile.bindings).map(binding => binding.ref),
      expectedSecretBindings: s.profile.bindings, accessToken: async () => "fixture-token", fetchImpl });
    expect(await authority(built.browserOrigin, built.apiOrigin)).toMatchObject({ pairId: s.input.pairId, generation: 1, image: s.image });
  });
  it.each(["reconciling", "generation", "traffic total", "unknown latest", "reserved tag"])("rejects %s before a create can be journalled", fault => {
    const s = setup();
    if (fault === "reconciling") s.service.reconciling = true;
    if (fault === "generation") s.service.observedGeneration = "6";
    if (fault === "traffic total") s.latest.percent = 99;
    if (fault === "unknown latest") s.service.latestReadyRevision += "-unknown";
    if (fault === "reserved tag") s.other.tag = "cp-44444444-g1-ui";
    expect(s.build).toThrow("unavailable");
  });
});
