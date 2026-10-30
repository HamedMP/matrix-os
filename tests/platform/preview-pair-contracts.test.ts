import { describe, expect, it } from "vitest";
import { PreviewPairManifestSchema, parseLivePreviewPairManifest, previewPairHandle } from "../../packages/contracts/src/preview-pair.js";

import { PAIR_NOW, previewPairManifestFixture } from "./preview-pair-test-support.js";

describe("strict collaboration preview pair producer/consumer contract", () => {
  it("accepts a complete canonical two-owner exact-source manifest", () => {
    expect(parseLivePreviewPairManifest(previewPairManifestFixture(), PAIR_NOW).pr).toBe(3022);
  });

  it.each([
    ["duplicate actors", (m: ReturnType<typeof previewPairManifestFixture>) => { m.members.member.actorId = m.members.owner.actorId; }],
    ["duplicate machines", (m: ReturnType<typeof previewPairManifestFixture>) => { m.members.member.machineId = m.members.owner.machineId; }],
    ["wrong role", (m: ReturnType<typeof previewPairManifestFixture>) => { m.members.member.role = "owner"; }],
    ["primary runtime", (m: ReturnType<typeof previewPairManifestFixture>) => { m.members.member.runtimeSlot = "primary"; }],
    ["wrong running source", (m: ReturnType<typeof previewPairManifestFixture>) => { m.members.owner.runningSha = "c".repeat(40); }],
    ["wrong desktop source", (m: ReturnType<typeof previewPairManifestFixture>) => { m.desktopArtifacts[0]!.sourceSha = "c".repeat(40); }],
    ["production origin", (m: ReturnType<typeof previewPairManifestFixture>) => { m.apiOrigin = "https://app.matrix-os.com"; }],
    ["wrong-pair origin", (m: ReturnType<typeof previewPairManifestFixture>) => { m.apiOrigin = "https://cp-deadbeef-g1-api---matrix-platform-preview-test.a.run.app"; }],
    ["wrong-generation origin", (m: ReturnType<typeof previewPairManifestFixture>) => { m.apiOrigin = "https://cp-11111111-g2-api---matrix-platform-preview-test.a.run.app"; }],
    ["shared browser/API origin", (m: ReturnType<typeof previewPairManifestFixture>) => { m.apiOrigin = m.browserOrigin; }],
    ["URL credentials", (m: ReturnType<typeof previewPairManifestFixture>) => { m.apiOrigin = "https://token@cp-11111111-g1-api---matrix-platform-preview-test.a.run.app"; }],
    ["executable traversal", (m: ReturnType<typeof previewPairManifestFixture>) => { m.desktopArtifacts[0]!.executableRelativePath = "../normal-app"; }],
    ["lifetime extension", (m: ReturnType<typeof previewPairManifestFixture>) => { m.expiresAt = "2026-11-03T11:00:00.000Z"; }],
  ] as const)("rejects %s", (_name, mutate) => {
    const manifest = previewPairManifestFixture();
    mutate(manifest);
    expect(PreviewPairManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects secrets, unexpected roles and duplicate desktop targets", () => {
    const manifest = previewPairManifestFixture();
    expect(PreviewPairManifestSchema.safeParse({ ...manifest, token: "not-a-handoff-field" }).success).toBe(false);
    expect(PreviewPairManifestSchema.safeParse({ ...manifest, members: { ...manifest.members, outsider: manifest.members.owner } }).success).toBe(false);
    expect(PreviewPairManifestSchema.safeParse({ ...manifest, desktopArtifacts: [...manifest.desktopArtifacts, ...manifest.desktopArtifacts] }).success).toBe(false);
  });

  it("refuses expiry, exhausted funding and stale control even when shape is valid", () => {
    expect(() => parseLivePreviewPairManifest(previewPairManifestFixture(), Date.parse("2026-11-03T00:00:00Z"))).toThrow();
    const unfunded = previewPairManifestFixture();
    unfunded.fundingExpiresAt = "2026-10-30T11:59:59Z";
    expect(() => parseLivePreviewPairManifest(unfunded, PAIR_NOW)).toThrow();
    const stale = previewPairManifestFixture();
    stale.members.member.lastControlAt = "2026-10-30T11:58:00Z";
    expect(() => parseLivePreviewPairManifest(stale, PAIR_NOW)).toThrow();
  });

  it("derives bounded role handles without allowing customer or arbitrary slots", () => {
    const id = previewPairManifestFixture().pairId;
    expect(previewPairHandle(3022, id, 1, "owner")).toBe("cp-3022-11111111-1-a");
    expect(previewPairHandle(999999999, id, 999, "member").length).toBeLessThanOrEqual(32);
    expect(() => previewPairHandle(-1, id, 1, "owner")).toThrow();
    expect(() => previewPairHandle(3022, "../../outside", 1, "owner")).toThrow();
  });
});
