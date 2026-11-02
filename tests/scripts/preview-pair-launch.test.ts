import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c } from "tar";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPreviewPairControlClient } from "../../scripts/preview-pair/control-client.js";
import { preparePreviewDesktop } from "../../scripts/preview-pair/desktop-client.js";
import { previewPairManifestFixture, PAIR_NOW } from "../platform/preview-pair-test-support.js";
let parent: string;
beforeEach(async () => { parent = await mkdtemp(join(tmpdir(), "eng418-launch-client-")); });
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });
async function fixture(fault?: string) {
  await writeFile(join(parent, "desktop"), "opaque native executable"); await chmod(join(parent, "desktop"), 0o755);
  await c({ cwd: parent, file: join(parent, "app.tar.gz"), gzip: true }, ["desktop"]);
  const archive = zipSync({ "preview-pair-app.tar.gz": await readFile(join(parent, "app.tar.gz")) });
  const manifest = previewPairManifestFixture(), sha = "c".repeat(40), sourceSha = manifest.sourceSha;
  const artifact = { ...manifest.desktopArtifacts[0], platform: "linux", arch: "x64", executableRelativePath: "desktop",
    artifactName: `preview-pair-desktop-${sourceSha}-linux-x64`, sha256: createHash("sha256").update(archive).digest("hex"), sizeBytes: archive.length };
  manifest.desktopArtifacts = [artifact];
  const receipt = { runId: 123, artifactId: 456, sourceSha: fault === "receipt" ? "d".repeat(40) : sourceSha,
    workflowSha: sha, platform: "linux", arch: "x64", sha256: artifact.sha256, sizeBytes: archive.length };
  const receipts = zipSync({ "456.json": strToU8(JSON.stringify(receipt)) });
  const metadata = (id: number) => ({ id, name: id === 456 ? artifact.artifactName : "preview-pair-source-receipts", expired: false,
    digest: `sha256:${createHash("sha256").update(id === 456 ? archive : receipts).digest("hex")}`,
    size_in_bytes: id === 456 ? archive.length : receipts.length, workflow_run: { id: 123 } });
  const fetchImpl = vi.fn<typeof fetch>(async (raw, init) => {
    const url = new URL(String(raw)); expect(init?.signal).toBeDefined();
    if (url.origin === "https://app.matrix-os.com") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer root-reader");
      if (url.pathname.endsWith("/setup")) return Response.json({ controllerSha: sha, controllerRef: `preview-pair-controller/${sha}`, requesterId: "user_requester", admissionEnabled: true });
      return Response.json(manifest);
    }
    expect(new Headers(init?.headers).get("authorization")).not.toBe("Bearer root-reader");
    if (url.hostname.endsWith("blob.core.windows.net")) {
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return new Response(url.pathname === "/456" ? archive : receipts);
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github-reader");
    if (url.pathname.endsWith("/attempts/1")) return Response.json({ id: 123, run_attempt: 1, event: "workflow_dispatch", status: "completed", conclusion: "success",
      path: ".github/workflows/desktop-build.yml", head_sha: fault === "workflow" ? sourceSha : sha,
      repository: { full_name: "HamedMP/matrix-os" }, head_repository: { full_name: "HamedMP/matrix-os" } });
    if (url.pathname.endsWith("/artifacts") && url.search) return Response.json({ total_count: 1, artifacts: [metadata(789)] });
    if (url.pathname.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: `https://productionresultssa1.blob.core.windows.net/${url.pathname.includes("456") ? "456" : "789"}` } });
    return Response.json(metadata(url.pathname.endsWith("456") ? 456 : 789));
  });
  const control = createPreviewPairControlClient({ origin: "https://app.matrix-os.com", token: "root-reader", now: () => PAIR_NOW, fetchImpl });
  return { control, manifest, fetchImpl, options: { control, pairId: manifest.pairId, token: "github-reader", platform: "linux", arch: "x64", fetchImpl, temporaryParent: parent } };
}
it("uses real canonical control, immutable GitHub receipt, authenticated ZIP and inner app readers before exposing an executable", async () => {
  const f = await fixture(), app = await preparePreviewDesktop(f.options);
  expect(await readFile(app.executable, "utf8")).toBe("opaque native executable");
  await app.dispose(); expect((await readdir(parent)).some(name => name.startsWith("matrix-preview-"))).toBe(false);
});
it.each(["receipt", "workflow"])("refuses %s provenance before downloading executable bytes", async fault => {
  const f = await fixture(fault); await expect(preparePreviewDesktop(f.options)).rejects.toThrow("unavailable");
  expect(f.fetchImpl.mock.calls.some(([raw]) => String(raw).includes("blob.core.windows.net/456"))).toBe(false);
});
it("rejects an unsupported target before any GitHub request or installed-app fallback", async () => {
  const f = await fixture(); await expect(preparePreviewDesktop({ ...f.options, platform: "win32" })).rejects.toThrow("unavailable");
  expect(f.fetchImpl.mock.calls.every(([raw]) => new URL(String(raw)).origin === "https://app.matrix-os.com")).toBe(true);
});
it("rejects expired canonical readiness before fetching bytes", async () => {
  const f = await fixture(); f.manifest.fundingExpiresAt = new Date(PAIR_NOW - 1).toISOString();
  await expect(preparePreviewDesktop(f.options)).rejects.toThrow("unavailable"); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});
