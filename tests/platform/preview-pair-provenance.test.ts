import { describe, expect, it } from "vitest";
import { verifyPreviewPairCandidate } from "../../packages/platform/src/preview-pair/provenance.js";
import { PAIR_NOW } from "./preview-pair-test-support.js";
import { previewPairProvenanceFixture as fixture } from "./preview-pair-provenance-fixture.js";

describe("pair candidate source is checked against independent canonical records", () => {
  it("binds exact source, unpromoted host bytes, completed desktop build and separate verified authority", async () => {
    const f = fixture();
    expect(await verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).toMatchObject(f.input);
    expect(f.source.pullRequest).toHaveBeenCalledWith(3022);
    expect(f.source.buildSource).toHaveBeenCalledWith(123, 456);
  });

  it.each(["ordinary", "wrong pair", "wrong generation", "wrong source"])("rejects a %s bundle identity even when canonical release metadata matches", async fault => {
    const f = fixture();
    const pairId = fault === "wrong pair" ? "99999999-9999-4999-8999-999999999999" : f.expected.pairId;
    const generation = fault === "wrong generation" ? 2 : f.expected.generation;
    const source = fault === "wrong source" ? "b".repeat(40) : f.expected.sourceSha;
    const version = fault === "ordinary" ? "v2026.10.31-pr3022-ordinary" : `v0.0.0-collabpair-${pairId}-g${generation}-${source}`;
    f.input.hostBundleVersion = version; f.release.version = version;
    await expect(verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).rejects.toThrow("unavailable");
    expect(f.source.authority).not.toHaveBeenCalled();
  });

  it("requires the configured source profile fingerprint before any provider reads", async () => {
    const f = fixture(), config = { ...f.config, sourceProfileFingerprint: "a".repeat(64) };
    await expect(verifyPreviewPairCandidate(f.input, f.expected, f.source, config, PAIR_NOW)).rejects.toThrow("unavailable");
    expect(f.source.authority).not.toHaveBeenCalled();
  });
  it("accepts the matching independently configured source profile fingerprint", async () => {
    const f = fixture(), sourceProfileFingerprint = "a".repeat(64), candidate = { ...f.input, sourceProfileFingerprint };
    await expect(verifyPreviewPairCandidate(candidate, f.expected, f.source, { ...f.config, sourceProfileFingerprint }, PAIR_NOW))
      .resolves.toMatchObject(candidate);
  });
  it("allows isolated execution with a different SHA from the reviewed controller", async () => {
    const f = fixture();
    f.build.head_sha = "2".repeat(40);
    f.receipt.workflowSha = f.build.head_sha;
    f.controller.executionSha = f.build.head_sha;
    expect(f.controller.executionSha).not.toBe(f.controller.controllerSha);
    await expect(verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).resolves.toMatchObject(f.input);
  });
  it("rejects a different full pair identity even when its abbreviated tag prefix and source match", async () => {
    const f = fixture();
    f.authority.pairId = f.expected.pairId.slice(0, -1) + (f.expected.pairId.endsWith("1") ? "2" : "1");
    expect(f.authority.pairId.slice(0, 8)).toBe(f.expected.pairId.slice(0, 8));
    await expect(verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).rejects.toThrow("Preview candidate is unavailable");
  });
  it("rejects another authority generation before preparing machines", async () => {
    const f = fixture(); f.authority.generation += 1;
    await expect(verifyPreviewPairCandidate(f.input, f.expected, f.source, f.config, PAIR_NOW)).rejects.toThrow("Preview candidate is unavailable");
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
