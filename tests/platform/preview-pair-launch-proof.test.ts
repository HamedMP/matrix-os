import { describe, expect, it } from "vitest";
import { issuePreviewPairLaunch, verifyPreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
import { PreviewPairLaunchAttestationSchema } from "../../packages/contracts/src/preview-pair-launch.js";
import { PAIR_NOW, previewPairManifestFixture } from "./preview-pair-test-support.js";
const secret = "s".repeat(40);
function input() { return { manifest: previewPairManifestFixture(), role: "owner", platform: "darwin", arch: "arm64", sourceOrigin: "https://app.matrix-os.com" }; }
describe("non-authorizing Source launch attestation", () => {
  it("binds one canonical role, exact artifact and short verification lifetime without a user credential or filesystem path", () => {
    const value: any = issuePreviewPairLaunch(input(), secret, PAIR_NOW);
    expect(value.context).toMatchObject({ actorId: "user_pair_owner", role: "owner", sourceSha: "a".repeat(40),
      machineId: "22222222-2222-4222-8222-222222222222", artifactId: 456 });
    expect(Date.parse(value.context.verifyBefore) - PAIR_NOW).toBeLessThanOrEqual(300_000);
    expect(verifyPreviewPairLaunch(value, secret, PAIR_NOW)).toEqual(value.context);
    expect(JSON.stringify(value)).not.toMatch(/accessToken|operatorSecret|userData|sessionData/);
  });
  it.each(["signature", "actor", "role", "source", "origin", "expired", "key rotation"])("rejects %s before canonical lookup", fault => {
    const value: any = issuePreviewPairLaunch(input(), secret, PAIR_NOW);
    if (fault === "signature") value.signature = "a".repeat(43);
    if (fault === "actor") value.context.actorId = "user_other";
    if (fault === "role") value.context.role = "member";
    if (fault === "source") value.context.sourceSha = "b".repeat(40);
    if (fault === "origin") value.context.sourceOrigin = "https://attacker.example";
    expect(verifyPreviewPairLaunch(value, fault === "key rotation" ? "t".repeat(40) : secret, fault === "expired" ? PAIR_NOW + 300_001 : PAIR_NOW)).toBeNull();
  });
  it("rejects an unsigned or oversized local context instead of treating it as preview authority", () => {
    expect(PreviewPairLaunchAttestationSchema.safeParse({ role: "owner", sourceSha: "a".repeat(40), padding: "x".repeat(20_000) }).success).toBe(false);
  });
});
