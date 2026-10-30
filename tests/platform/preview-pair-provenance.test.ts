import { describe, expect, it, vi } from "vitest";
import { verifyPreviewPairCandidate } from "../../packages/platform/src/preview-pair/provenance.js";
import { loadPreviewPairConfig, type EnabledPreviewPairConfig } from "../../packages/platform/src/preview-pair/config.js";
import { PAIR_NOW, previewPairConfigurationFixture, previewPairManifestFixture } from "./preview-pair-test-support.js";

function fixture() {
  const m = previewPairManifestFixture();
  const config = loadPreviewPairConfig(previewPairConfigurationFixture()) as EnabledPreviewPairConfig;
  const input = { sourceSha: m.sourceSha, hostBundleVersion: "v2026.10.30-pr3022-test", hostBundleSha256: "e".repeat(64),
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
  const authority = { browserOrigin: m.browserOrigin, apiOrigin: m.apiOrigin, identityIssuer: config.identityIssuer,
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

describe("pair candidate source is checked against independent canonical records", () => {
  it("binds exact source, unpromoted host bytes, completed desktop build and separate verified authority", async () => {
    const f = fixture();
    expect(await verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).toMatchObject(f.input);
    expect(f.source.pullRequest).toHaveBeenCalledWith(3022);
    expect(f.source.buildSource).toHaveBeenCalledWith(123, 456);
  });

  it("allows isolated execution with a different SHA from the reviewed controller", async () => {
    const f = fixture();
    f.build.head_sha = "2".repeat(40);
    f.receipt.workflowSha = f.build.head_sha;
    f.controller.executionSha = f.build.head_sha;
    expect(f.controller.executionSha).not.toBe(f.controller.controllerSha);
    await expect(verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).resolves.toMatchObject(f.input);
  });

  it.each(["closed", "fork", "moved head", "promoted release", "wrong host source", "wrong artifact digest",
    "failed build", "wrong receipt source", "wrong workflow", "API classified as browser", "production credentials", "stale authority", "wrong controller SHA", "wrong execution SHA", "wrong receipt workflow SHA"])(
    "rejects %s before preparing any machines", async fault => {
      const f = fixture();
      switch (fault) {
        case "wrong controller SHA": f.controller.controllerSha = "1".repeat(40); break;
        case "wrong execution SHA": f.controller.executionSha = "1".repeat(40); break;
        case "wrong receipt workflow SHA": f.receipt.workflowSha = "1".repeat(40); break;
        case "closed": f.pull.state = "closed"; break;
        case "fork": f.pull.head.repo.full_name = "outside/fork"; break;
        case "moved head": f.pull.head.sha = "f".repeat(40); break;
        case "promoted release": f.promotedChannels.push("dev"); break;
        case "wrong host source": f.release.gitCommit = "f".repeat(40); break;
        case "wrong artifact digest": f.artifact.digest = `sha256:${"f".repeat(64)}`; break;
        case "failed build": f.build.conclusion = "failure"; break;
        case "wrong receipt source": f.receipt.sourceSha = "f".repeat(40); break;
        case "wrong workflow": f.build.path = ".github/workflows/untrusted.yml"; break;
        case "API classified as browser": f.authority.appDomainHosts.push(new URL(f.authority.apiOrigin).hostname); break;
        case "production credentials": f.authority.clerkSecretRef = "clerk-secret-key"; break;
        case "stale authority": f.authority.observedAt = "2026-10-30T11:00:00Z"; break;
      }
      await expect(verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).rejects.toThrow("Preview candidate is unavailable");
    });
});
