import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createImageClient } from "../../packages/kernel/src/image-gen.js";

const fakeImageBase64 = Buffer.from("fake-png-data").toString("base64");

function geminiResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({
      candidates: [{
        content: {
          parts: [{
            inlineData: { mimeType: "image/png", data: fakeImageBase64 },
          }],
        },
      }],
    }),
  };
}

function createIconApp(homePath: string) {
  const app = new Hono();

  app.post("/api/apps/:slug/icon", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return c.json({ error: "Invalid slug" }, 400);
    }

    let body: { style?: string } = {};
    try { body = await c.req.json(); } catch { /* no body is fine */ }

    let iconStyle = body.style ?? "";
    if (!iconStyle) {
      try {
        const desktop = JSON.parse(readFileSync(join(homePath, "system/desktop.json"), "utf-8"));
        iconStyle = desktop.iconStyle ?? "";
      } catch { /* ignore */ }
    }
    if (!iconStyle) {
      iconStyle = "Light premium iOS/macOS skeuomorphic source artwork for an app icon. Render a complete full-square 1:1 image with four visible 90-degree square corners; the bright warm off-white or pale pastel background must continue uninterrupted all the way into every corner. Absolutely no rounded canvas corners, no rounded-square tile, no app-icon frame, no corner mask, no black/dark/transparent corners, no vignette hiding the corners, and no border radius baked into the image.";
    }

    const client = createImageClient("test-key");
    const name = slug.replace(/-/g, " ").replace(/_/g, " ");
    const prompt = `App icon for '${name}': ${iconStyle}, no text, 1:1 square`;
    const iconsDir = join(homePath, "system/icons");
    const result = await client.generateImage(prompt, {
      aspectRatio: "1:1",
      imageDir: iconsDir,
      saveAs: `${slug}.png`,
      fetchFn: vi.fn().mockResolvedValue(geminiResponse()),
    });
    return c.json({
      iconUrl: `/files/system/icons/${slug}.png`,
      etag: '"etag-1"',
      cost: result.cost,
      prompt,
    });
  });

  return app;
}

describe("POST /api/apps/:slug/icon", () => {
  let homePath: string;
  let app: Hono;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "icon-gen-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    app = createIconApp(homePath);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("generates icon and returns URL", async () => {
    const res = await app.request("/api/apps/calculator/icon", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { iconUrl: string; etag: string; cost: number };
    expect(body.iconUrl).toBe("/files/system/icons/calculator.png");
    expect(body.etag).toBe('"etag-1"');
    expect(typeof body.cost).toBe("number");
    expect(existsSync(join(homePath, "system/icons/calculator.png"))).toBe(true);
  });

  it("rejects invalid slug", async () => {
    const res = await app.request("/api/apps/evil%21%40/icon", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("creates icons directory if missing", async () => {
    expect(existsSync(join(homePath, "system/icons"))).toBe(false);
    const res = await app.request("/api/apps/notes/icon", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(homePath, "system/icons"))).toBe(true);
  });

  it("uses default light skeuomorphic icon style when no desktop.json", async () => {
    const res = await app.request("/api/apps/timer/icon", { method: "POST" });
    const body = await res.json() as { prompt: string };
    expect(body.prompt).toContain("Light premium iOS/macOS skeuomorphic source artwork");
    expect(body.prompt).toContain("no rounded canvas corners");
    expect(body.prompt).toContain("no black/dark/transparent corners");
    expect(body.prompt).toContain("timer");
  });

  it("reads icon style from desktop.json", async () => {
    writeFileSync(
      join(homePath, "system/desktop.json"),
      JSON.stringify({ iconStyle: "pixel art retro 8-bit style" }),
    );
    const res = await app.request("/api/apps/calculator/icon", { method: "POST" });
    const body = await res.json() as { prompt: string };
    expect(body.prompt).toContain("pixel art retro 8-bit style");
    expect(body.prompt).not.toContain("Light premium iOS/macOS");
  });

  it("uses style from request body over desktop.json", async () => {
    writeFileSync(
      join(homePath, "system/desktop.json"),
      JSON.stringify({ iconStyle: "pixel art retro 8-bit style" }),
    );
    const res = await app.request("/api/apps/notes/icon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style: "watercolor painting soft edges" }),
    });
    const body = await res.json() as { prompt: string };
    expect(body.prompt).toContain("watercolor painting soft edges");
    expect(body.prompt).not.toContain("pixel art");
  });
});
