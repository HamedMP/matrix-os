import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import manifest from "../../home/apps/app-gallery/matrix.json";
import { hashSources, isBuildStale, writeBuildStamp } from "../../packages/gateway/src/app-runtime/build-cache";

it("rebuilds Gallery when only its imported shared identity colors change", async () => {
  const home = await mkdtemp(join(tmpdir(), "matrix-gallery-build-inputs-"));
  const app = join(home, "apps/app-gallery");
  const shared = join(home, "apps/_shared");
  try {
    await mkdir(app, { recursive: true });
    await mkdir(shared, { recursive: true });
    const css = join(shared, "app-identities.css");
    await writeFile(css, ":root { --app-accent: green; }");
    await writeBuildStamp(app, { sourceHash: await hashSources(app, manifest.build.sourceGlobs), lockfileHash: "", builtAt: Date.now(), exitCode: 0 });
    expect(await isBuildStale(app, manifest.build.sourceGlobs)).toBe(false);
    await writeFile(css, ":root { --app-accent: coral; }");
    expect(await isBuildStale(app, manifest.build.sourceGlobs)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
