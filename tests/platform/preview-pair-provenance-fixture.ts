import { vi } from "vitest";
import { loadPreviewPairConfig, type EnabledPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { PAIR_NOW, previewPairConfigurationFixture, previewPairManifestFixture } from "./preview-pair-test-support.js";

export function previewPairProvenanceFixture() {
  const m = previewPairManifestFixture();
  const config = loadPreviewPairConfig(previewPairConfigurationFixture()) as EnabledPreviewPairConfig;
  const input = { sourceSha: m.sourceSha, hostBundleVersion: m.members.owner.installedVersion, hostBundleSha256: "e".repeat(64),
    desktopArtifacts: m.desktopArtifacts, browserOrigin: m.browserOrigin, apiOrigin: m.apiOrigin,
    identityIssuer: m.identityIssuer, platformSource: m.platformSource };
  const expected = { pairId: m.pairId, generation: m.generation, pr: m.pr, sourceSha: m.sourceSha };
  const pull = { number: m.pr, state: "open", head: { sha: m.sourceSha, repo: { full_name: m.repository } }, base: { repo: { full_name: m.repository } } };
  const release = { version: input.hostBundleVersion, channel: null, gitCommit: m.sourceSha, sourcePr: m.pr, sha256: input.hostBundleSha256 };
  const artifact = { id: 456, name: m.desktopArtifacts[0]!.artifactName, digest: `sha256:${m.desktopArtifacts[0]!.sha256}`,
    size_in_bytes: 1_000, expired: false, workflow_run: { id: 123 } };
  const build = { id: 123, status: "completed", conclusion: "success", path: ".github/workflows/desktop-build.yml",
    head_sha: "d".repeat(40), event: "workflow_dispatch", repository: { full_name: m.repository }, head_repository: { full_name: m.repository } };
  const receipt = { runId: 123, artifactId: 456, sourceSha: m.sourceSha, workflowSha: build.head_sha };
  const authority = { pairId: m.pairId, generation: m.generation, browserOrigin: m.browserOrigin, apiOrigin: m.apiOrigin, identityIssuer: config.identityIssuer,
    sourceSha: m.sourceSha, serviceAccount: config.serviceAccount, clerkSecretRef: config.clerkSecretRef,
    databaseSecretRef: config.databaseSecretRef, ticketKeysSecretRef: config.ticketKeysSecretRef,
    appDomainHosts: [new URL(m.browserOrigin).hostname], browserRevision: "pair-revision", apiRevision: "pair-revision",
    observedAt: new Date(PAIR_NOW).toISOString() };
  const promotedChannels: string[] = [];
  const controller = { controllerSha: config.reviewedControllerSha, executionSha: build.head_sha, workflowPath: build.path, treeSha: "f".repeat(40) };
  const source = { pullRequest: vi.fn(async () => pull), hostRelease: vi.fn(async () => ({ release, promotedChannels })),
    artifact: vi.fn(async () => artifact), build: vi.fn(async () => build),
    buildSource: vi.fn(async () => receipt),
    controllerProof: vi.fn(async () => controller), authority: vi.fn(async () => authority) };
  return { input, expected, config, source, pull, release, artifact, build, receipt, authority, promotedChannels, controller };
}

