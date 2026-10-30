export const PAIR_NOW = Date.parse("2026-10-30T12:00:00.000Z");
const SHA = "a".repeat(40);
export function previewPairManifestFixture() {
  const pairId = "11111111-1111-4111-8111-111111111111";
  const member = (role: "owner" | "member") => ({
    role, actorId: `user_pair_${role}`, machineId: role === "owner"
      ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
    handle: `cp-3022-11111111-1-${role === "owner" ? "a" : "b"}`,
    runtimeSlot: `cp-3022-11111111-1-${role === "owner" ? "a" : "b"}`,
    installedVersion: "v2026.10.30-pr3022-test", runningVersion: "v2026.10.30-pr3022-test",
    installedSha: SHA, runningSha: SHA, authorityGeneration: 1,
    lastControlAt: "2026-10-30T11:59:55.000Z",
  });
  return {
    schemaVersion: 1, repository: "HamedMP/matrix-os", pairId, generation: 1, pr: 3022,
    sourceSha: SHA, state: "ready", outdated: false,
    createdAt: "2026-10-30T11:00:00.000Z", expiresAt: "2026-11-02T11:00:00.000Z",
    fundingExpiresAt: "2026-10-30T17:00:00.000Z", organizationId: "org_pair_fixture",
    outsiderActorId: "user_pair_outsider", identityIssuer: "https://pair-test.clerk.accounts.dev",
    browserOrigin: "https://cp-11111111-g1-ui---matrix-platform-preview-test.a.run.app",
    apiOrigin: "https://cp-11111111-g1-api---matrix-platform-preview-test.a.run.app",
    platformSource: { kind: "candidate", sha: SHA }, dataPolicy: "reset",
    members: { owner: member("owner"), member: member("member") },
    desktopArtifacts: [{ platform: "darwin", arch: "arm64", workflow: ".github/workflows/desktop-build.yml",
      runId: 123, artifactId: 456, artifactName: "matrix-preview-mac-arm64", sourceSha: SHA,
      sha256: "b".repeat(64), sizeBytes: 1_000, format: "zip",
      executableRelativePath: "Matrix OS.app/Contents/MacOS/Matrix OS" }],
  };
}


export function previewPairConfigurationFixture() {
  return {
    MATRIX_PREVIEW_PAIR_ENABLED: "true",
    MATRIX_PREVIEW_PAIR_FIXTURES: JSON.stringify([{ id: "fixture-a", ownerActorId: "user_pair_owner",
      memberActorId: "user_pair_member", outsiderActorId: "user_pair_outsider", organizationId: "org_pair_fixture" }]),
    MATRIX_PREVIEW_PAIR_CONTROL_ORIGIN: "https://app.matrix-os.com",
    MATRIX_PREVIEW_PAIR_MAINTAINER_ORG_ID: "org_internal_test",
    MATRIX_PREVIEW_PAIR_IDENTITY_ISSUER: "https://pair-test.clerk.accounts.dev",
    MATRIX_PREVIEW_PAIR_CLERK_PUBLISHABLE_KEY: "pk_test_fixture",
    MATRIX_PREVIEW_PAIR_CLERK_SECRET_REF: "clerk-preview-pair-test",
    MATRIX_PREVIEW_PAIR_DATABASE_SECRET_REF: "database-preview-pair-test",
    MATRIX_PREVIEW_PAIR_TICKET_KEYS_SECRET_REF: "ticket-keys-preview-pair-test",
    MATRIX_PREVIEW_PAIR_CONTROLLER_SHA: "d".repeat(40),
    MATRIX_PREVIEW_PAIR_SERVICE_ACCOUNT: "matrix-pair-preview-test@matrix-test.iam.gserviceaccount.com",
  };
}

