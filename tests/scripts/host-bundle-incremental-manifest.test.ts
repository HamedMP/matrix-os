import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIncrementalManifest,
  canonicalManifestJson,
} from "../../scripts/host-bundle-incremental-manifest.mjs";

const tempDirs: string[] = [];

async function tempAppDir() {
  const dir = await mkdtemp(join(tmpdir(), "matrix-host-bundle-manifest-"));
  tempDirs.push(dir);
  const appDir = join(dir, "app");
  await mkdir(appDir, { recursive: true });
  return { dir, appDir };
}

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

describe("host bundle incremental manifest", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("builds a deterministic content-addressed manifest for app files", async () => {
    const { dir, appDir } = await tempAppDir();
    const objectDir = join(dir, "objects");
    await mkdir(join(appDir, "bin"), { recursive: true });
    await mkdir(join(appDir, "nested"), { recursive: true });
    await writeFile(join(appDir, "nested", "b.txt"), "bravo");
    await writeFile(join(appDir, "a.sh"), "#!/usr/bin/env bash\n");
    await chmod(join(appDir, "a.sh"), 0o755);
    await symlink("../a.sh", join(appDir, "bin", "a-link"));

    const manifest = await buildIncrementalManifest({
      appDir,
      objectDir,
      version: "v2026.06.17-1",
      baseVersion: "v2026.06.16-1",
    });

    expect(manifest).toMatchObject({
      manifestVersion: 1,
      version: "v2026.06.17-1",
      baseVersion: "v2026.06.16-1",
      objectRoot: "system-bundles/objects/sha256",
      requiresFullBundle: true,
      excludedPrefixes: ["node_modules/"],
      delete: [],
    });
    await expect(readFile(join(objectDir, "sha256", sha256("#!/usr/bin/env bash\n")), "utf8")).resolves.toBe(
      "#!/usr/bin/env bash\n",
    );
    await expect(readFile(join(objectDir, "sha256", sha256("bravo")), "utf8")).resolves.toBe("bravo");
    expect(manifest.files.map((file) => file.path)).toEqual(["a.sh", "nested/b.txt"]);
    expect(manifest.files[0]).toMatchObject({
      type: "file",
      path: "a.sh",
      sha256: sha256("#!/usr/bin/env bash\n"),
      size: 20,
      mode: "0755",
      url: `system-bundles/objects/sha256/${sha256("#!/usr/bin/env bash\n")}`,
    });
    expect(manifest.symlinks).toEqual([{ path: "bin/a-link", target: "../a.sh" }]);
    expect(manifest.protected).toEqual([
      "/home/matrix/home/system/desktop.json",
      "/home/matrix/home/system/theme.json",
      "/home/matrix/home/system/wallpapers/",
      "/home/matrix/home/system/icons/",
      "/home/matrix/home/conversations/",
      "/home/matrix/home/memory/",
    ]);
  });

  it("excludes staged dependency stores from the incremental object set", async () => {
    const { dir, appDir } = await tempAppDir();
    const objectDir = join(dir, "objects");
    await mkdir(join(appDir, "node_modules", "huge-package"), { recursive: true });
    await writeFile(join(appDir, "node_modules", "huge-package", "index.js"), "dependency");
    await writeFile(join(appDir, "runtime.js"), "runtime");

    const manifest = await buildIncrementalManifest({
      appDir,
      objectDir,
      version: "v1",
    });

    expect(manifest.files.map((file) => file.path)).toEqual(["runtime.js"]);
    await expect(readFile(join(objectDir, "sha256", sha256("runtime")), "utf8")).resolves.toBe("runtime");
    await expect(readFile(join(objectDir, "sha256", sha256("dependency")), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes canonical JSON bytes with stable key order", async () => {
    const { appDir } = await tempAppDir();
    await writeFile(join(appDir, "file.txt"), "hello");

    const manifest = await buildIncrementalManifest({ appDir, version: "v1" });
    const json = canonicalManifestJson(manifest);

    expect(json).toContain('"manifestVersion": 1,\n  "version": "v1"');
    expect(json).toContain(`"url": "system-bundles/objects/sha256/${sha256("hello")}"`);
    expect(json.endsWith("\n")).toBe(true);
  });

  it("rejects symlink targets that escape the staged app tree", async () => {
    const { appDir } = await tempAppDir();
    await symlink("../../etc/passwd", join(appDir, "bad-link"));

    await expect(buildIncrementalManifest({ appDir, version: "v1" })).rejects.toThrow(
      "escapes app root",
    );
  });
});
