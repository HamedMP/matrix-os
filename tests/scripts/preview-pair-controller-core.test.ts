import { describe, expect, it, vi } from "vitest";
import { createPreviewPairControlClient } from "../../scripts/preview-pair/control-client.js";
import { admitBuiltPreviewPair } from "../../scripts/preview-pair/controller-core.js";
import { previewPairManifestFixture } from "../platform/preview-pair-test-support.js";
const manifest = previewPairManifestFixture(), request = { runId: 42, pairId: manifest.pairId, pr: manifest.pr,
  generation: 1, sourceSha: manifest.sourceSha, requesterId: "user_requester" };
function setup(fault = false, reused = false) {
  let polls = 0;
  const events: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname; events.push(path);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer operator-fixture");
    if (path.endsWith("/publication")) { polls++; return Response.json({ publication: fault ? "rejected" : "accepted", ready: !fault && polls === 2,
      ...(!fault && polls === 2 ? { browserOrigin: manifest.browserOrigin, apiOrigin: manifest.apiOrigin, sourceProfileFingerprint: "f".repeat(64) } : {}) }); }
    const summary = { pairId: manifest.pairId, generation: 1, revision: 1, pr: manifest.pr, sourceSha: manifest.sourceSha,
      state: "ready", outdated: false, expiresAt: manifest.expiresAt, reportPath: `/api/preview-pairs/${manifest.pairId}` };
    if (path.endsWith("/status")) return Response.json({ ...summary, kind: "pair", currentGeneration: 1, infrastructureReady: true, acceptance: "not_run", failedStage: null });
    if (path.endsWith("/actions")) return Response.json({ state: "cleanup_pending" });
    return Response.json({ ...summary, ownedRequest: !reused });
  });
  const control = createPreviewPairControlClient({ origin: "https://api.matrix-os.com", token: "operator-fixture", fetchImpl });
  return { control, events, fetchImpl, request, action: "create" as const, imageSha256: "e".repeat(64), sleep: async () => undefined,
    candidate: { sourceSha: manifest.sourceSha, sourceProfileFingerprint: "f".repeat(64), hostBundleVersion: manifest.members.owner.installedVersion,
      hostBundleSha256: "b".repeat(64), desktopArtifacts: manifest.desktopArtifacts, browserOrigin: manifest.browserOrigin, apiOrigin: manifest.apiOrigin,
      identityIssuer: manifest.identityIssuer, platformSource: manifest.platformSource } };
}
describe("trusted build handoff waits for proven publication before canonical adoption", () => {
  it("polls publication then admits once, and waits for both real runtime readiness observations", async () => {
    const s = setup();
    expect(await admitBuiltPreviewPair(s)).toMatchObject({ pairId: request.pairId, state: "ready" });
    expect(s.events).toEqual([`/vps/preview-pairs/requests/${request.pairId}/publication`, `/vps/preview-pairs/requests/${request.pairId}/publication`,
      "/vps/preview-pairs", `/vps/preview-pairs/${request.pairId}/status`]);
  });
  it("does not admit a rejected cloud publication and only retires its own recorded request", async () => {
    const s = setup(true);
    await expect(admitBuiltPreviewPair(s)).rejects.toThrow("unavailable");
    expect(s.events).toEqual([`/vps/preview-pairs/requests/${request.pairId}/publication`, `/vps/preview-pairs/requests/${request.pairId}/actions`]);
  });
  it("retires a redundant unadopted intent without polling or stopping the reused canonical pair", async () => {
    const s = setup(false, true);
    expect(await admitBuiltPreviewPair(s)).toMatchObject({ ownedRequest: false });
    expect(s.events.at(-1)).toBe(`/vps/preview-pairs/requests/${request.pairId}/actions`);
    expect(s.events.some(path => path.endsWith("/status"))).toBe(false);
  });
});
