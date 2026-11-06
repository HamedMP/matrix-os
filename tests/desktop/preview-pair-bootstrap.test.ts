import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeDesktopPreview } from "@desktop/main/preview-pair-startup";
import { createPreviewPairProfile } from "@desktop/main/preview-pair-profiles";
import { issuePreviewPairLaunch, verifyPreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
import { PAIR_NOW, previewPairManifestFixture } from "../platform/preview-pair-test-support.js";
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "eng418-bootstrap-home-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function setup() {
  const proof = issuePreviewPairLaunch({ manifest: previewPairManifestFixture(), role: "owner", platform: "darwin", arch: "arm64", sourceOrigin: "https://app.matrix-os.com" }, "s".repeat(40), PAIR_NOW);
  const paths = await createPreviewPairProfile(proof.context, home), app = { setName: vi.fn(), setPath: vi.fn() };
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => { expect(app.setPath).not.toHaveBeenCalled();
    return verifyPreviewPairLaunch(JSON.parse(String(init?.body)), "s".repeat(40), PAIR_NOW) ? Response.json({ valid: true }) : new Response(null, { status: 404 }); });
  return { proof, paths, app, env: { MATRIX_PREVIEW_PAIR_CONTEXT: JSON.stringify(proof), OPERATOR_USER_DATA_DIR: paths.userData },
    options: { home, buildSource: { commit: proof.context.sourceSha, ancestors: [] }, platform: "darwin", arch: "arm64", now: () => PAIR_NOW, fetchFn } };
}
describe("actual desktop pre-ready startup orchestration", () => {
  it("verifies Source and owned role state before selecting both Electron paths", async () => {
    const f = await setup();
    expect(await initializeDesktopPreview(f.app, f.env, f.options)).toMatchObject({ role: "owner" });
    expect(f.app.setPath.mock.calls).toEqual([["userData", f.paths.userData], ["sessionData", f.paths.sessionData]]);
  });
  it.each(["proof", "normal path"])("fails %s without selecting any Electron profile", async fault => {
    const f = await setup();
    if (fault === "proof") f.env.MATRIX_PREVIEW_PAIR_CONTEXT = JSON.stringify({ ...f.proof, signature: "a".repeat(43) });
    else f.env.OPERATOR_USER_DATA_DIR = join(home, "normal-electron");
    await expect(initializeDesktopPreview(f.app, f.env, f.options)).rejects.toThrow("unavailable"); expect(f.app.setPath).not.toHaveBeenCalled();
  });
  it("does not alter the normal app when preview context is absent", async () => {
    const f = await setup(); expect(await initializeDesktopPreview(f.app, {}, f.options)).toBeNull();
    expect(f.app.setName).not.toHaveBeenCalled(); expect(f.app.setPath).not.toHaveBeenCalled(); expect(f.options.fetchFn).not.toHaveBeenCalled();
  });
});
