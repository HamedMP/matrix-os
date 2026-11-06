import { describe, expect, it } from "vitest";
import { loadPreviewPairCandidateRuntimeProfile } from "../../packages/platform/src/preview-pair/candidate-profile.js";
import { previewPairManifestFixture } from "./preview-pair-test-support.js";
import { candidateRuntimeEnvironment } from "./preview-pair-candidate-env.js";
describe("candidate runtime-only startup profile", () => {
  it("is absent by default even in an ordinary provider-enabled platform", () => {
    expect(loadPreviewPairCandidateRuntimeProfile({ HETZNER_API_TOKEN: "ordinary-provider-fixture" })).toBeUndefined();
  });
  it("binds a test-only registration/read runtime to the exact pair generation and both existing handles", () => {
    const m = previewPairManifestFixture();
    expect(loadPreviewPairCandidateRuntimeProfile(candidateRuntimeEnvironment())).toEqual({
      pairId: m.pairId, generation: m.generation, pr: m.pr, apiOrigin: m.apiOrigin,
      handles: [m.members.owner.handle, m.members.member.handle] });
  });
  it.each([
    { MATRIX_PREVIEW_PAIR_RUNTIME_ONLY: "maybe" }, { CUSTOMER_VPS_ENABLED: "true" }, { MATRIX_PREVIEW_PAIR_ENABLED: "true" },
    { MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED: "true" }, { MATRIX_FUNDED_AI_RUNTIME_ENABLED: "true" },
    { MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "true" }, { HETZNER_API_TOKEN: "fixture" },
    { MATRIX_PREVIEW_RUNTIME_SECRET: "fixture" }, { AI_FUNDED_CREDENTIAL_HASH_SECRET: "fixture" },
    { GH_TOKEN: "fixture" }, { GOOGLE_APPLICATION_CREDENTIALS: "/fixture/not-allowed" },
    { CLERK_SECRET_KEY: "sk_live_fixture" }, { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_fixture" },
    { PLATFORM_PUBLIC_URL: "https://app.matrix-os.com" }, { MATRIX_PREVIEW_PAIR_GENERATION: "2" },
    { MATRIX_APP_ORIGIN: "https://app.matrix-os.com" }, { NEXT_PUBLIC_MATRIX_APP_URL: "https://app.matrix-os.com" },
    { MATRIX_API_ORIGIN: "https://api.matrix-os.com" },
    { PLATFORM_JWT_SECRET: candidateRuntimeEnvironment().PLATFORM_SECRET },
  ])("rejects privileged, misbound or production profile override %j", override => {
    expect(() => loadPreviewPairCandidateRuntimeProfile({ ...candidateRuntimeEnvironment(), ...override })).toThrow("Preview pairs are unavailable");
  });
});
