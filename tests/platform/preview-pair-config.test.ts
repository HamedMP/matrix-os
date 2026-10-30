import { describe, expect, it } from "vitest";
import { loadPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";

import { previewPairConfigurationFixture as configured } from "./preview-pair-test-support.js";

describe("Preview pair activation configuration", () => {
  it("is disabled with no configuration and never activates by handle shape", () => {
    expect(loadPreviewPairConfig({})).toEqual({ enabled: false });
  });

  it("accepts a bounded dedicated fixture pool and Preview-only identity bindings", () => {
    expect(loadPreviewPairConfig(configured())).toMatchObject({ enabled: true, maxActivePairs: 1,
      maxQueued: 32, maxLifetimeMs: 72 * 60 * 60 * 1_000, fixtures: [{ id: "fixture-a" }] });
  });

  it.each([
    ["unknown flag", { MATRIX_PREVIEW_PAIR_ENABLED: "maybe" }],
    ["untrusted control origin", { MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN: "https://untrusted.example" }],
    ["production Clerk", { MATRIX_PREVIEW_PAIR_CLERK_PUBLISHABLE_KEY: "pk_live_not_for_preview" }],
    ["non-Preview service account", { MATRIX_PREVIEW_PAIR_SERVICE_ACCOUNT: "production@matrix-test.iam.gserviceaccount.com" }],
    ["missing identity issuer", { MATRIX_PREVIEW_PAIR_IDENTITY_ISSUER: "" }],
    ["malformed fixture JSON", { MATRIX_PREVIEW_PAIR_FIXTURES: "{" }],
  ])("rejects %s", (_name, override) => {
    expect(() => loadPreviewPairConfig({ ...configured(), ...override })).toThrow("Preview pairs are unavailable");
  });

  it("rejects overlapping actors, organizations and unbounded fixture pools", () => {
    const env = configured();
    const [fixture] = JSON.parse(env.MATRIX_PREVIEW_PAIR_FIXTURES);
    for (const fixtures of [[{ ...fixture, memberActorId: fixture.ownerActorId }],
      [fixture, { ...fixture, id: "fixture-b" }], Array.from({ length: 9 }, (_, i) => ({ ...fixture, id: `fixture-${i}` }))]) {
      expect(() => loadPreviewPairConfig({ ...env, MATRIX_PREVIEW_PAIR_FIXTURES: JSON.stringify(fixtures) })).toThrow();
    }
  });
});
