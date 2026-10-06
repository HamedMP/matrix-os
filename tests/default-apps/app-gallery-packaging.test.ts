import { readFile, access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import catalog from "../../home/system/app-gallery.json";
import { iconUrlForSlug } from "../../shell/src/lib/app-launch";

describe("curated gallery release packaging", () => {
  it("builds the portable starter before hashing the shipped home template", async () => {
    const script = await readFile("scripts/build-host-bundle.sh", "utf8");
    const build = script.indexOf('node "$ROOT_DIR/scripts/build-app-gallery-template.mjs"');
    expect(build).toBeGreaterThan(-1);
    expect(build).toBeLessThan(script.indexOf("generateTemplateManifest"));
  });
  it("resolves every curated icon to an actual shipped file", async () => {
    for (const icon of ["app-gallery", ...catalog.apps.map(app => app.icon)]) {
      const url = iconUrlForSlug(icon);
      expect(url).toMatch(/^\/icons\/[a-z0-9-]+\.(svg|png)$/);
      await expect(access(`home/system${url}`)).resolves.toBeUndefined();
    }
  });
});
