import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { COLLABORATIVE_APP_ICON_MAX_BYTES } from "@matrix-os/contracts";
import { invalidateAppIndexCache } from "../../packages/gateway/src/app-runtime/app-index.js";
import { createCollaborativeAppPresentationResolver } from "../../packages/gateway/src/collaboration/collaborative-app-presentation.js";

/**
 * ENG-490: the owner gateway captures the same icon file and manifest name its own launcher
 * shows, and only inert, bounded raster bytes ever leave the home.
 */
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("owner-artwork")]);

describe("collaborative app presentation resolver", () => {
  let home: string;

  beforeEach(async () => {
    invalidateAppIndexCache();
    home = await mkdtemp(join(tmpdir(), "matrix-app-presentation-"));
    await mkdir(join(home, "system/icons"), { recursive: true });
  });

  afterEach(async () => {
    invalidateAppIndexCache();
    await rm(home, { recursive: true, force: true });
  });

  async function app(manifest: Record<string, unknown>) {
    const dir = join(home, "apps", String(manifest.slug));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "matrix.json"), JSON.stringify({ version: "1.0.0", runtime: "vite", runtimeVersion: "^1.0.0", build: { command: "vite build", output: "dist" }, ...manifest }));
  }

  it("captures the manifest name and the owner launcher's raster icon with its content address", async () => {
    await app({ slug: "team-tracker", name: "Team Tracker", icon: "tracker-art" });
    await writeFile(join(home, "system/icons/tracker-art.png"), png);
    const presentation = await createCollaborativeAppPresentationResolver({ homePath: home })("team-tracker");
    expect(presentation).toEqual({
      name: "Team Tracker",
      icon: { sha256: createHash("sha256").update(png).digest("hex"), contentType: "image/png", bytes: new Uint8Array(png) },
    });
  });

  it("omits SVG artwork, mislabelled bytes, oversized files, and symlinks", async () => {
    await app({ slug: "vector", name: "Vector", icon: "vector" });
    await writeFile(join(home, "system/icons/vector.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await app({ slug: "fake", name: "Fake", icon: "fake" });
    await writeFile(join(home, "system/icons/fake.png"), "<!doctype html><script>alert(1)</script>");
    await app({ slug: "huge", name: "Huge", icon: "huge" });
    const huge = Buffer.alloc(COLLABORATIVE_APP_ICON_MAX_BYTES + 1);
    png.copy(huge);
    await writeFile(join(home, "system/icons/huge.png"), huge);
    await app({ slug: "linked", name: "Linked", icon: "linked" });
    const outside = join(home, "outside.png");
    await writeFile(outside, png);
    await symlink(outside, join(home, "system/icons/linked.png"));

    const resolve = createCollaborativeAppPresentationResolver({ homePath: home });
    for (const [slug, name] of [["vector", "Vector"], ["fake", "Fake"], ["huge", "Huge"], ["linked", "Linked"]] as const) {
      expect(await resolve(slug)).toEqual({ name });
    }
  });

  it("sends no icon when the app has none of its own, so members keep the letter tile", async () => {
    // The launcher's generic fallback artwork must never be uploaded as the owner's icon.
    await writeFile(join(home, "system/icons/game-center.png"), png);
    await writeFile(join(home, "system/icons/game.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await app({ slug: "iconless", name: "Iconless" });
    await app({ slug: "missing-art", name: "Missing Art", icon: "missing-art" });

    const resolve = createCollaborativeAppPresentationResolver({ homePath: home });
    expect(await resolve("iconless")).toEqual({ name: "Iconless" });
    expect(await resolve("missing-art")).toEqual({ name: "Missing Art" });
  });

  it("bounds the display name and returns nothing for an unknown app", async () => {
    await app({ slug: "long-name", name: `  ${"N".repeat(200)}\u0007  ` });
    const resolve = createCollaborativeAppPresentationResolver({ homePath: home });
    expect((await resolve("long-name"))?.name).toBe("N".repeat(120));
    expect(await resolve("missing-app")).toBeNull();
  });
});
