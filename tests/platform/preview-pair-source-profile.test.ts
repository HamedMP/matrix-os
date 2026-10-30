import { describe, expect, it } from "vitest";
import { loadPreviewPairConfig, type EnabledPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { loadPreviewPairSourceProfile, previewPairSourceFingerprint } from "../../packages/platform/src/preview-pair/source-profile.js";
import { previewPairConfigurationFixture } from "./preview-pair-test-support.js";

function sourceProfileFixture() {
  return { project: "matrix-test", projectNumber: "123456789012", region: "europe-west1", service: "matrix-platform-preview",
    r2Prefix: "preview/pairs", activeTicketKeyId: "preview-a", bindings: {
      CLERK_SECRET_KEY: { ref: "matrix-preview-clerk", version: "1" },
      PLATFORM_DATABASE_URL: { ref: "matrix-preview-db", version: "2" },
      MATRIX_COLLABORATION_TICKET_KEYS: { ref: "matrix-preview-tickets", version: "3" },
      PLATFORM_SECRET: { ref: "matrix-preview-host", version: "4" },
      PLATFORM_JWT_SECRET: { ref: "matrix-preview-jwt", version: "5" },
      EDGE_ROUTER_SECRET: { ref: "matrix-preview-edge", version: "6" },
    } };
}
function environment() {
  const env = previewPairConfigurationFixture();
  const profile = sourceProfileFixture();
  profile.bindings.CLERK_SECRET_KEY.ref = env.MATRIX_PREVIEW_PAIR_CLERK_SECRET_REF;
  profile.bindings.PLATFORM_DATABASE_URL.ref = env.MATRIX_PREVIEW_PAIR_DATABASE_SECRET_REF;
  profile.bindings.MATRIX_COLLABORATION_TICKET_KEYS.ref = env.MATRIX_PREVIEW_PAIR_TICKET_KEYS_SECRET_REF;
  return { ...env, MATRIX_PREVIEW_PAIR_SOURCE_PROFILE: JSON.stringify(profile),
    MATRIX_PREVIEW_PAIR_OPERATOR_SECRET: "pair-operator-" + "p".repeat(40), PLATFORM_SECRET: "control-" + "c".repeat(40) };
}

describe("approved source profile is configuration, never candidate input", () => {
  it("does not parse dormant configuration or allocate resources", () => {
    expect(loadPreviewPairSourceProfile({ MATRIX_PREVIEW_PAIR_SOURCE_PROFILE: "bad" }, { enabled: false })).toBeUndefined();
  });
  it("accepts only pinned test bindings and a separate operator credential", () => {
    const env = environment();
    expect(loadPreviewPairSourceProfile(env, loadPreviewPairConfig(env))).toMatchObject({ service: "matrix-platform-preview",
      projectNumber: "123456789012", operatorSecret: env.MATRIX_PREVIEW_PAIR_OPERATOR_SECRET,
      bindings: { PLATFORM_DATABASE_URL: { ref: env.MATRIX_PREVIEW_PAIR_DATABASE_SECRET_REF, version: "2" } } });
  });
  it("pins resource identity while allowing the operator credential to rotate", () => {
    const env = environment(), config = loadPreviewPairConfig(env) as EnabledPreviewPairConfig;
    const profile = loadPreviewPairSourceProfile(env, config)!;
    const digest = previewPairSourceFingerprint(profile, config);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(previewPairSourceFingerprint({ ...profile, operatorSecret: "replacement-operator-" + "r".repeat(40) }, config)).toBe(digest);
    expect(previewPairSourceFingerprint({ ...profile, bindings: { ...profile.bindings,
      PLATFORM_DATABASE_URL: { ...profile.bindings.PLATFORM_DATABASE_URL, version: "99" } } }, config)).not.toBe(digest);
  });
  it.each(["alias", "foreign ref", "duplicate ref", "customer prefix", "candidate", "operator reuse", "foreign project", "raw key", "unsupported origin family"])("rejects %s before resource creation", fault => {
    const env = environment(), profile = JSON.parse(env.MATRIX_PREVIEW_PAIR_SOURCE_PROFILE);
    if (fault === "alias") profile.bindings.PLATFORM_DATABASE_URL.version = "latest";
    if (fault === "foreign ref") profile.bindings.PLATFORM_DATABASE_URL.ref = "matrix-production-db";
    if (fault === "duplicate ref") profile.bindings.PLATFORM_SECRET = profile.bindings.PLATFORM_JWT_SECRET;
    if (fault === "customer prefix") profile.r2Prefix = "users";
    if (fault === "candidate") Object.assign(env, { MATRIX_PREVIEW_PAIR_RUNTIME_ONLY: "true" });
    if (fault === "operator reuse") env.MATRIX_PREVIEW_PAIR_OPERATOR_SECRET = env.PLATFORM_SECRET;
    if (fault === "foreign project") profile.project = "foreign-project";
    if (fault === "unsupported origin family") profile.service = "matrix-pair-preview";
    if (fault === "raw key") profile.bindings.PLATFORM_SECRET.value = "p".repeat(40);
    env.MATRIX_PREVIEW_PAIR_SOURCE_PROFILE = JSON.stringify(profile);
    expect(() => loadPreviewPairSourceProfile(env, loadPreviewPairConfig(env))).toThrow("unavailable");
  });
});
