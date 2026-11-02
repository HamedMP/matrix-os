import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startPreviewDesktop, previewDesktopEnvironment } from "../../scripts/preview-pair/desktop-process.js";
import { issuePreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
import { previewPairManifestFixture, PAIR_NOW } from "../platform/preview-pair-test-support.js";
let parent: string;
beforeEach(async () => { parent = await mkdtemp(join(tmpdir(), "eng418-local-process-")); });
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });
const proof = () => issuePreviewPairLaunch({ manifest: previewPairManifestFixture(), role: "owner", platform: "darwin", arch: "arm64", sourceOrigin: "https://app.matrix-os.com" }, "s".repeat(40), PAIR_NOW);
it("does not inherit cloud/control tokens, development overrides or Node preload into candidate execution", () => {
  const value = previewDesktopEnvironment(proof(), "/owned/profile", "1234", { HOME: parent, PATH: process.env.PATH,
    GITHUB_TOKEN: "private", MATRIX_PLATFORM_SECRET: "private", NODE_OPTIONS: "--require /private", OPERATOR_GATEWAY_URL: "https://root.invalid", ELECTRON_RENDERER_URL: "https://wrong.invalid" });
  expect(value.HOME).toBe(parent); for (const key of ["GITHUB_TOKEN", "MATRIX_PLATFORM_SECRET", "NODE_OPTIONS", "OPERATOR_GATEWAY_URL", "ELECTRON_RENDERER_URL"]) expect(value).not.toHaveProperty(key);
});
async function executable(text: string) {
  const path = join(parent, "fixture-app"); await writeFile(path, '#!/usr/bin/node\n' + text); await chmod(path, 0o755); return path;
}
it("starts and stops only its actual new child after the real loopback acknowledgement", async () => {
  const path = await executable(`const net=require('node:net'); const c=JSON.parse(process.env.MATRIX_PREVIEW_PAIR_CONTEXT).context;
const value={nonce:c.nonce,pairId:c.pairId,generation:c.generation,role:c.role,sourceSha:c.sourceSha,machineId:c.machineId,pid:process.pid};
const s=net.connect({host:'127.0.0.1',port:Number(process.env.MATRIX_PREVIEW_PAIR_READY_PORT)},()=>s.end(JSON.stringify(value)+'\\n')); setInterval(()=>{},1000);`);
  const running = await startPreviewDesktop({ executable: path, proof: proof(), userData: parent, timeoutMs: 3000 });
  try { expect(running.pid).toBe(running.child.pid); expect(running.reused).toBe(false); }
  finally { await running.stop(); await running.closed; }
  expect(running.child.signalCode).toBe("SIGTERM");
});
it("reports a real child failure promptly instead of pretending both apps opened", async () => {
  const path = await executable("process.exit(3)");
  await expect(startPreviewDesktop({ executable: path, proof: proof(), userData: parent, timeoutMs: 3000 })).rejects.toThrow("stopped before startup");
});
