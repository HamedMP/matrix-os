import { describe, expect, it } from "vitest";
import { createPreviewQualification, PREVIEW_QUALIFICATION_SCENARIOS } from "../../packages/platform/src/preview-pair/evidence.js";
import { previewPairManifestFixture, PAIR_NOW } from "./preview-pair-test-support.js";
function fixture() {
  const manifest = previewPairManifestFixture(), current = { pairId: manifest.pairId, generation: manifest.generation, pr: manifest.pr,
    sourceSha: manifest.sourceSha, state: "ready", revision: 4, outdated: false, expiresAt: manifest.expiresAt };
  const observation = (scenario = "first_later_share", surface = "electron_desktop", boundary = "live"): any => {
    const item = PREVIEW_QUALIFICATION_SCENARIOS[scenario as keyof typeof PREVIEW_QUALIFICATION_SCENARIOS];
    return { scenario, surface, boundary, role: item.role, result: "pass", observedAt: new Date(PAIR_NOW + 1000).toISOString(),
      steps: item.steps.map(step => ({ step, result: "pass" })),
      captures: [{ kind: "screenshot", url: "https://github.com/user-attachments/assets/test-image" }, { kind: "recording", url: "https://github.com/user-attachments/assets/test-video" }] };
  };
  const input = { pairId: manifest.pairId, generation: manifest.generation, sourceSha: manifest.sourceSha, observations: [observation()] };
  return { manifest, current, input, startedAt: PAIR_NOW, now: PAIR_NOW + 2000, observation };
}
describe("bound manual preview qualification exports never turn infrastructure/fixtures into live acceptance", () => {
  it("keeps missing cases pending and every manual result explicitly unreviewed", () => {
    const f = fixture(), report = createPreviewQualification(f);
    expect(report.summary).toMatchObject({ required: 16, liveReportedPasses: 1, pending: 15, requiresReview: true });
    expect(report).not.toHaveProperty("acceptance"); expect(report.provenance.sourceSha).toBe(f.manifest.sourceSha);
  });
  it("never counts all fixture successes as a live pass", () => {
    const f = fixture(); f.input.observations = Object.keys(PREVIEW_QUALIFICATION_SCENARIOS).flatMap(s => ["electron_desktop", "web_desktop"].map(surface => f.observation(s, surface, "fixture")));
    expect(createPreviewQualification(f).summary).toMatchObject({ liveReportedPasses: 0, fixtureReportedPasses: 16, pending: 16 });
  });
  it.each(["generation", "source", "pair", "incomplete", "duplicate", "role", "capture", "credential", "future", "unknown"])("rejects %s drift or incomplete claimed pass", fault => {
    const f = fixture(), row = f.input.observations[0];
    if (fault === "generation") f.current.generation++;
    if (fault === "source") f.input.sourceSha = "d".repeat(40);
    if (fault === "pair") f.current.pairId = "99999999-9999-4999-8999-999999999999";
    if (fault === "incomplete") row.steps.pop();
    if (fault === "duplicate") f.input.observations.push(row);
    if (fault === "role") row.role = "outsider";
    if (fault === "capture") row.captures = [];
    if (fault === "credential") row.captures[0].url += "?token=private";
    if (fault === "future") row.observedAt = new Date(PAIR_NOW + 60_000).toISOString();
    if (fault === "unknown") row.providerError = "private runtime error";
    expect(() => createPreviewQualification(f)).toThrow();
  });
  it("preserves a failed real product step when infrastructure is still healthy", () => {
    const f = fixture(), row = f.input.observations[0]; row.result = "fail"; row.steps = [{ step: "preflight", result: "fail" }]; row.captures = [];
    expect(createPreviewQualification(f).summary).toMatchObject({ failed: 1, liveReportedPasses: 0, pending: 16 });
  });
});
it("rejects a current report whose PR identity drifted despite matching pair/source fields", () => {
  const manifest = previewPairManifestFixture();
  expect(() => createPreviewQualification({ manifest, startedAt: PAIR_NOW, now: PAIR_NOW,
    current: { pairId: manifest.pairId, generation: 1, pr: manifest.pr + 1, sourceSha: manifest.sourceSha, state: "ready", revision: 1, outdated: false, expiresAt: manifest.expiresAt },
    input: { pairId: manifest.pairId, generation: 1, sourceSha: manifest.sourceSha, observations: [] } })).toThrow();
});
