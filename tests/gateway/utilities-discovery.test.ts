import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listApps } from "../../packages/gateway/src/apps.js";
import { parseAppManifest } from "../../packages/gateway/src/app-manifest.js";

const appDir = join(__dirname, "../../home/apps/utilities");
describe("Utilities shared discovery", () => {
  it("is a single first-party bundled Vite app with complete build inputs", async () => {
    const manifest = JSON.parse(readFileSync(join(appDir, "matrix.json"), "utf8"));
    expect(parseAppManifest(manifest)).toMatchObject({ name: "Utilities", runtime: "vite" });
    expect(manifest).toMatchObject({ slug: "utilities", listingTrust: "first_party", icon: "utilities" });
    expect(manifest.build.sourceGlobs).toEqual(expect.arrayContaining(["src/**", "public/**", "package.json", "build.mjs", "build-inputs.json", "toolkit-source.json"]));
    const home = mkdtempSync(join(tmpdir(), "utilities-discovery-"));
    try {
      mkdirSync(join(home, "apps/utilities/dist"), { recursive: true });
      writeFileSync(join(home, "apps/utilities/matrix.json"), JSON.stringify(manifest));
      writeFileSync(join(home, "apps/utilities/index.html"), "<!doctype html><div id='root'></div>");
      writeFileSync(join(home, "apps/utilities/dist/index.html"), "<!doctype html><div id='root'></div>");
      mkdirSync(join(home, "system/icons"), { recursive: true });
      writeFileSync(join(home, "system/icons/utilities.svg"), readFileSync(join(__dirname, "../../home/system/icons/utilities.svg")));
      const apps = await listApps(home);
      expect(apps).toHaveLength(1);
      expect(apps[0]).toMatchObject({ name: "Utilities", file: "utilities/index.html", path: "/files/apps/utilities/index.html", runtime: "vite" });
      expect(apps[0].iconUrl).toMatch(/^\/icons\/utilities\.svg\?v=/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("is available in the bundled app gallery", () => {
    const gallery = JSON.parse(readFileSync(join(__dirname, "../../home/system/app-store.json"), "utf8"));
    expect(gallery.find((app: { id: string }) => app.id === "utilities")).toMatchObject({ name: "Utilities", source: "bundled", category: "Utilities" });
  });
});
