import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { previewPairManifestFixture, PAIR_NOW } from "../platform/preview-pair-test-support.js";
import { issuePreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
it("a real Member process failure stops the newly opened Owner and disposes only this launch's artifact", async () => {
  const home = await mkdtemp(join(tmpdir(), "eng418-partial-launch-")), executable = join(home, "fixture-app");
  try {
    await writeFile(executable, `#!/usr/bin/node
const net=require('node:net'),fs=require('node:fs'); const c=JSON.parse(process.env.MATRIX_PREVIEW_PAIR_CONTEXT).context;
if(c.role==='member')process.exit(5);
fs.writeFileSync(process.env.OPERATOR_USER_DATA_DIR+'/fixture-pid',String(process.pid));
const s=net.connect({host:'127.0.0.1',port:Number(process.env.MATRIX_PREVIEW_PAIR_READY_PORT)},()=>s.end(JSON.stringify({nonce:c.nonce,pairId:c.pairId,generation:c.generation,role:c.role,sourceSha:c.sourceSha,machineId:c.machineId,pid:process.pid})+'\\n'));setInterval(()=>{},1000);`); await chmod(executable, 0o755);
    const manifest: any = previewPairManifestFixture(), dispose = vi.fn(async () => undefined);
    vi.doMock("../../scripts/preview-pair/desktop-client.js", () => ({ preparePreviewDesktop: async () => ({ manifest, artifact: manifest.desktopArtifacts[0], executable, directory: home, dispose }) }));
    const { openPreviewPair } = await import("../../scripts/preview-pair/launch.js");
    const control: any = { launch: async (_pair: string, request: any) => issuePreviewPairLaunch({ manifest, ...request, sourceOrigin: "https://app.matrix-os.com" }, "s".repeat(40), PAIR_NOW) };
    await expect(openPreviewPair({ control, pairId: manifest.pairId, token: "fixture", platform: "darwin", arch: "arm64", home })).rejects.toThrow("stopped before startup");
    const pid = Number(await readFile(join(home, ".matrixos", "preview-pairs", manifest.pairId, "g1", "owner", "user-data", "fixture-pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(); expect(dispose).toHaveBeenCalledTimes(1);
  } finally { vi.doUnmock("../../scripts/preview-pair/desktop-client.js"); await rm(home, { recursive: true, force: true }); }
});
