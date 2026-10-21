import { readFile, access } from "node:fs/promises";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import { iconUrlForSlug } from "../../shell/src/lib/app-launch";
import { resolveSystemIconPath } from "../../packages/gateway/src/default-icons";

describe("curated gallery release packaging", () => {
  it("builds the portable starter before hashing the shipped home template", async () => {
    const script = await readFile("scripts/build-host-bundle.sh", "utf8");
    const build = script.indexOf('node "$ROOT_DIR/scripts/build-app-gallery-template.mjs"');
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(script.indexOf("generateTemplateManifest"));
  });
  it("installs the portable starter's pinned dependencies before building its runtime", async () => {
    const script = await readFile("scripts/build-app-gallery-template.mjs", "utf8");
    const install = script.indexOf('await run("pnpm", ["install", "--frozen-lockfile"])');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(script.indexOf('await run(process.execPath, [vite, "build"])'));
  });
  it("resolves every curated icon to an actual shipped file", async () => {
    for (const icon of ["app-gallery", ...catalog.apps.map(app => app.icon)]) {
      const url = iconUrlForSlug(icon);
      expect(url).toMatch(/^\/icons\/[a-z0-9-]+\.(svg|png)$/);
      const requestedFile = basename(url!);
      const stem = requestedFile.replace(/\.(svg|png)$/, "");
      const shippedPath = await resolveSystemIconPath("home", requestedFile);
      // PNG requests preserve owner artwork precedence; the gateway may serve
      // the app's shipped SVG, but a generic game fallback is not sufficient.
      expect([
        `home/system/icons/${stem}.png`,
        `home/system/icons/${stem}.svg`,
      ]).toContain(shippedPath);
      await expect(access(shippedPath!)).resolves.toBeUndefined();
    }
  });
});
