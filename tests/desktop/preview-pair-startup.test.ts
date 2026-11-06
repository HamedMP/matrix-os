import { describe, expect, it, vi } from "vitest";
import { verifyDesktopPreviewContext } from "@desktop/main/preview-pair-context";
import { issuePreviewPairLaunch, verifyPreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
import { PAIR_NOW, previewPairManifestFixture } from "../platform/preview-pair-test-support.js";
const secret = "s".repeat(40);
function setup() {
  const proof = issuePreviewPairLaunch({ manifest: previewPairManifestFixture(), role: "owner", platform: "darwin", arch: "arm64", sourceOrigin: "https://app.matrix-os.com" }, secret, PAIR_NOW);
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://app.matrix-os.com/api/preview-pairs/launch/verify");
    expect(new Headers(init?.headers).has("authorization")).toBe(false); expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Actual Source crypto is retained; only HTTP/current provider facts are a fixture.
    return verifyPreviewPairLaunch(JSON.parse(String(init?.body)), secret, PAIR_NOW) ? Response.json({ valid: true }) : new Response(null, { status: 404 });
  });
  const options = { buildSource: { commit: proof.context.sourceSha, ancestors: [] }, platform: "darwin", arch: "arm64", now: () => PAIR_NOW, fetchFn };
  return { proof, options, fetchFn, verify: () => verifyDesktopPreviewContext(JSON.stringify(proof), options) };
}
describe("Electron verifies Source context before any profile/auth bootstrap", () => {
  it("accepts only a Source-verified descriptor for its embedded candidate and actual target", async () => {
    const s = setup(), context = await s.verify();
    expect(context).toMatchObject({ role: "owner", machineId: s.proof.context.machineId, sourceSha: s.options.buildSource.commit });
    expect(Object.isFrozen(context)).toBe(true); expect(s.fetchFn).toHaveBeenCalledTimes(1);
  });
  it("leaves normal startup unchanged when no preview descriptor was requested", async () => {
    const s = setup(); expect(await verifyDesktopPreviewContext(undefined, s.options)).toBeNull(); expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it.each(["build", "missing build", "platform", "architecture", "expired", "foreign source", "unsigned"])("rejects %s before any Source request or profile access", async fault => {
    const s = setup(); let raw = JSON.stringify(s.proof);
    if (fault === "build") s.options.buildSource.commit = "b".repeat(40);
    if (fault === "missing build") s.options.buildSource = null as any;
    if (fault === "platform") s.options.platform = "linux";
    if (fault === "architecture") s.options.arch = "x64";
    if (fault === "expired") s.options.now = () => PAIR_NOW + 300_001;
    if (fault === "foreign source") { s.proof.context.sourceOrigin = "https://attacker.example" as any; raw = JSON.stringify(s.proof); }
    if (fault === "unsigned") raw = JSON.stringify(s.proof.context);
    await expect(verifyDesktopPreviewContext(raw, s.options)).rejects.toThrow("unavailable"); expect(s.fetchFn).not.toHaveBeenCalled();
  });
  it.each(["signature", "retired", "offline"])("fails closed on %s verification without interpreting the descriptor as a user session", async fault => {
    const s = setup();
    if (fault === "signature") s.proof.signature = "a".repeat(43);
    if (fault === "retired") s.fetchFn.mockResolvedValue(new Response(null, { status: 404 }));
    if (fault === "offline") s.fetchFn.mockRejectedValue(new TypeError("network unavailable"));
    await expect(s.verify()).rejects.toThrow("unavailable"); expect(s.fetchFn).toHaveBeenCalledTimes(1);
  });
});
