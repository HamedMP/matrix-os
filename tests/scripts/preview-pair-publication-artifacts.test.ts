import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPreviewPairHostBundle } from "../../scripts/preview-pair/publication-artifacts.js";
import { producePreviewPairHostFixture, previewBuildRequest as request } from "./preview-pair-build-fixture.js";
let owned: string | undefined;
afterEach(async () => { if (owned) await rm(owned, { recursive: true, force: true }); owned = undefined; });

describe("privileged publication consumes existing host metadata producers without executing candidate payload", () => {
  it("accepts the real release/incremental/manifest producer output with exact opaque bytes", async () => {
    const f = await producePreviewPairHostFixture(); owned = f.directory;
    expect(await readPreviewPairHostBundle(f.dist, request)).toMatchObject({ version: f.version, size: Buffer.byteLength("opaque-not-executed-bundle-bytes") });
  });
  it.each(["source", "version", "bundle", "incremental"])("rejects %s disagreement before any privileged publication", async fault => {
    const f = await producePreviewPairHostFixture(); owned = f.directory;
    if (fault === "bundle") await writeFile(join(f.dist, "matrix-host-bundle.tar.gz"), "corrupt same boundary");
    else if (fault === "incremental") await writeFile(join(f.dist, "incremental-manifest.json"), "{}");
    else {
      const file = join(f.dist, "manifest.json"), manifest = JSON.parse(await readFile(file, "utf8"));
      if (fault === "source") manifest.gitCommit = "b".repeat(40); else manifest.version = "v2026.10.31-ordinary";
      await writeFile(file, JSON.stringify(manifest));
    }
    await expect(readPreviewPairHostBundle(f.dist, request)).rejects.toThrow("unavailable");
  });
});
