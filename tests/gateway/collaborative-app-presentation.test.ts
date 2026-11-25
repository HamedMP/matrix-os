import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidateAppIndexCache } from "../../packages/gateway/src/app-runtime/app-index.js";
import { createCollaborativeAppPresentationResolver } from "../../packages/gateway/src/collaboration/collaborative-app-presentation.js";

/**
 * ENG-490: the owner gateway captures the same icon file and manifest name its own launcher
 * shows, and only inert, bounded raster bytes ever leave the home.
 */
const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#e02f70" } }).png().toBuffer();

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
    expect(presentation?.name).toBe("Team Tracker");
    expect(presentation?.icon?.contentType).toBe("image/png");
    const icon = presentation!.icon!;
    expect(icon.sha256).toBe(createHash("sha256").update(icon.bytes).digest("hex"));
    expect((await sharp(icon.bytes).metadata()).width).toBe(32);

  });

  it("resizes large valid artwork and preserves its recognizable color within the thumbnail budget", async () => {
    await app({ slug: "large", name: "Large", icon: "large" });
    // Uncompressed valid PNG exceeds both the old upload cap and the thumbnail budget.
    const mark = await sharp({ create: { width: 256, height: 256, channels: 4, background: "#2c63dc" } }).png().toBuffer();
    const source = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#e02f70" } })
      .composite([{ input: mark, top: 512, left: 512 }]).png({ compressionLevel: 0 }).toBuffer();
    expect(source.length).toBeGreaterThan(256 * 1024);
    await writeFile(join(home, "system/icons/large.png"), source);
    const result = await createCollaborativeAppPresentationResolver({ homePath: home })("large");
    expect(result?.icon).toBeDefined();
    expect(result!.icon!.bytes.length).toBeLessThanOrEqual(48 * 1024);
    const decoded = await sharp(result!.icon!.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info.width).toBeLessThanOrEqual(96);
    expect(decoded.info.height).toBeLessThanOrEqual(96);
    expect([...decoded.data.subarray(0, 3)]).toEqual([224, 47, 112]);
    const markPixel = (60 * decoded.info.width + 60) * decoded.info.channels;
    expect([...decoded.data.subarray(markPixel, markPixel + 3)]).toEqual([44, 99, 220]);
  });

  it("rejects corrupt raster and excessive decoding dimensions", async () => {
    await app({ slug: "corrupt", name: "Corrupt", icon: "corrupt" });
    await writeFile(join(home, "system/icons/corrupt.png"), png.subarray(0, 40));
    await app({ slug: "wide", name: "Wide", icon: "wide" });
    const wide = await sharp({ create: { width: 8193, height: 1, channels: 4, background: "red" } }).png().toBuffer();
    await writeFile(join(home, "system/icons/wide.png"), wide);
    const resolve = createCollaborativeAppPresentationResolver({ homePath: home });
    expect(await resolve("corrupt")).toEqual({ name: "Corrupt" });
    expect(await resolve("wide")).toEqual({ name: "Wide" });
  });

  it("omits SVG artwork, mislabelled bytes, oversized files, and symlinks", async () => {
    await app({ slug: "vector", name: "Vector", icon: "vector" });
    await writeFile(join(home, "system/icons/vector.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await app({ slug: "fake", name: "Fake", icon: "fake" });
    await writeFile(join(home, "system/icons/fake.png"), "<!doctype html><script>alert(1)</script>");
    await app({ slug: "huge", name: "Huge", icon: "huge" });
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1);
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
    // The launcher's generic fallback artwork must never be sent as the owner's icon.
    await writeFile(join(home, "system/icons/game-center.png"), png);
    await writeFile(join(home, "system/icons/game.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await app({ slug: "iconless", name: "Iconless" });
    await app({ slug: "missing-art", name: "Missing Art", icon: "missing-art" });

    const resolve = createCollaborativeAppPresentationResolver({ homePath: home });
    expect(await resolve("iconless")).toEqual({ name: "Iconless" });
    expect(await resolve("missing-art")).toEqual({ name: "Missing Art" });
  });

  it.each(["jpeg", "webp"] as const)("decodes existing %s artwork and sends a PNG thumbnail", async (format) => {
    await app({ slug: format, name: format, icon: format });
    const source = await sharp(png).toFormat(format).toBuffer();
    await writeFile(join(home, `system/icons/${format}.png`), source);
    const result = await createCollaborativeAppPresentationResolver({ homePath: home })(format);
    expect(result?.icon?.contentType).toBe("image/png");
    expect((await sharp(result!.icon!.bytes).metadata()).format).toBe("png");
  });

  it("rejects a symlink icon directory", async () => {
    await app({ slug: "parent-link", name: "Parent", icon: "linked" });
    await mkdir(join(home, "external-icons"));
    await writeFile(join(home, "external-icons/linked.png"), png);
    await rm(join(home, "system/icons"), { recursive: true });
    await symlink(join(home, "external-icons"), join(home, "system/icons"));
    expect(await createCollaborativeAppPresentationResolver({ homePath: home })("parent-link")).toEqual({ name: "Parent" });
  });

  it("bounds the display name and returns nothing for an unknown app", async () => {
    await app({ slug: "long-name", name: `  ${"N".repeat(200)}\u0007  ` });
    const resolve = createCollaborativeAppPresentationResolver({ homePath: home });
    expect((await resolve("long-name"))?.name).toBe("N".repeat(120));
    expect(await resolve("missing-app")).toBeNull();
  });
});
