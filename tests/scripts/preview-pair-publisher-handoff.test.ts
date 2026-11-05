import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewBuildRequest as request, producePreviewPairHostFixture } from "./preview-pair-build-fixture.js";
import { publishPreviewPairBuild } from "../../scripts/preview-pair/controller-publish.js";
import { previewControllerGitHub } from "../../scripts/preview-pair/controller-artifacts.js";
import { runPreviewTool } from "../../scripts/preview-pair/reviewed-process.js";
vi.mock("../../scripts/preview-pair/reviewed-process.js", () => ({ runPreviewTool: vi.fn() }));
const imageRepository = "europe-west1-docker.pkg.dev/matrix-test/matrix-preview-pairs/matrix-platform";
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(runPreviewTool).mockReset(); });
async function setup(corrupt = false) {
  const fixture = await producePreviewPairHostFixture();
  const files: Record<string, Uint8Array> = {};
  for (const name of ["manifest.json", "release.json", "incremental-manifest.json", "matrix-host-bundle.tar.gz", "matrix-host-bundle.tar.gz.sha256"]) {
    files[name] = await readFile(join(fixture.dist, name));
  }
  for (const name of await readdir(join(fixture.dist, "objects", "sha256"))) files[`objects/sha256/${name}`] = await readFile(join(fixture.dist, "objects", "sha256", name));
  if (corrupt) files["matrix-host-bundle.tar.gz"] = new TextEncoder().encode("corrupt-candidate");
  const archives = [zipSync(files), zipSync({ "image.tar": new TextEncoder().encode("simulated-image-provider-boundary") })];
  const artifacts = archives.map((bytes, i) => ({ id: 100 + i, name: `preview-pair-${i ? "image" : "host"}-${request.runId}`,
    expired: false, size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: { id: request.runId } }));
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const value = String(url);
    if (value.includes("productionresultssa1.blob")) { expect(new Headers(init?.headers).has("authorization")).toBe(false); return new Response(archives[Number(value.split("/").at(-1))]!); }
    if (value.endsWith("/artifacts?per_page=17")) return Response.json({ total_count: artifacts.length, artifacts });
    const index = Number(value.match(/\/artifacts\/(\d+)/)?.[1]) - 100;
    if (!artifacts[index]) return new Response(null, { status: 404 });
    if (value.endsWith("/zip")) return new Response(null, { status: 302, headers: { location: `https://productionresultssa1.blob.core.windows.net/${index}` } });
    return Response.json(artifacts[index]);
  });
  vi.stubGlobal("fetch", fetchImpl);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PAIR_CONTROL_ORIGIN: "https://app.matrix-os.com",
    PAIR_REGISTRY_TOKEN: "registry-fixture", PAIR_BUNDLES_ACCESS_KEY_ID: "bundles-fixture", PAIR_BUNDLES_SECRET_ACCESS_KEY: "bundles-secret-fixture",
    PAIR_BUNDLES_ENDPOINT: "https://test.r2.cloudflarestorage.com", PAIR_BUNDLES_BUCKET: "preview-bundles-test", PAIR_RELEASE_REGISTRATION_SECRET: "root-register-fixture" };
  vi.mocked(runPreviewTool).mockImplementation(async (file, args, childEnv, stdin) => {
    expect(childEnv).not.toHaveProperty("PAIR_OPERATOR_SECRET"); expect(childEnv).not.toHaveProperty("GITHUB_TOKEN");
    if (file === "docker") { expect(childEnv).not.toHaveProperty("PLATFORM_SECRET");
      if (args[0] === "login") expect(stdin).toBe(env.PAIR_REGISTRY_TOKEN);
      if (args[0] === "image") return JSON.stringify([`${imageRepository}@sha256:${"e".repeat(64)}`]);
    } else {
      expect(args).toEqual(["scripts/publish-release-r2.mjs", fixture.version, "--channel", "none", "--source-pr", String(request.pr), "--include-incremental-objects"]);
      expect(childEnv.PLATFORM_PUBLIC_URL).toBe("https://app.matrix-os.com");
      expect(childEnv).not.toHaveProperty("PAIR_REGISTRY_TOKEN"); expect(childEnv.PLATFORM_SECRET).toBe(env.PAIR_RELEASE_REGISTRATION_SECRET);
    }
    return "ignored opaque provider output";
  });
  return { fixture, options: { github: previewControllerGitHub("github-fixture", "c".repeat(40)), token: "github-fixture", request, env,
    prepared: { kind: "request", ownedRequest: true, pairId: request.pairId, generation: 1, state: "prepared", expiresAt: "2026-11-02T00:00:00Z",
      profileFingerprint: "f".repeat(64), buildContext: { imageRepository, clerkPublishableKey: "pk_test_fixture", identityIssuer: "https://pair-test.clerk.accounts.dev" } } } };
}
describe("real artifact-to-privileged-publisher handoff", () => {
  it("binds actual producer bytes and strips unrelated credentials from each fixed reviewed subprocess", async () => {
    const s = await setup();
    try {
      const result = await publishPreviewPairBuild(s.options);
      expect(result).toMatchObject({ imageSha256: "e".repeat(64), hostBundle: { version: s.fixture.version } });
      expect(vi.mocked(runPreviewTool).mock.calls.map(([tool, args]) => [tool === "docker" ? tool : "node", args[0]])).toEqual([
        ["docker", "load"], ["docker", "tag"], ["docker", "login"], ["docker", "push"], ["docker", "image"], ["node", "scripts/publish-release-r2.mjs"]]);
    } finally { await s.fixture.dispose(); }
  });
  it("rejects missing registration authority before uploading even a registry image", async () => {
    const s = await setup();
    delete (s.options.env as Record<string, unknown>).PAIR_RELEASE_REGISTRATION_SECRET;
    try { await expect(publishPreviewPairBuild(s.options)).rejects.toThrow("unavailable"); expect(runPreviewTool).not.toHaveBeenCalled(); }
    finally { await s.fixture.dispose(); }
  });
  it("rejects mismatching candidate bytes before any privileged tool or registration runs", async () => {
    const s = await setup(true);
    try { await expect(publishPreviewPairBuild(s.options)).rejects.toThrow("unavailable"); expect(runPreviewTool).not.toHaveBeenCalled(); }
    finally { await s.fixture.dispose(); }
  });
});
