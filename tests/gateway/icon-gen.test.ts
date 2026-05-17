import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
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

    const iconsDir = join(homePath, "system/icons");
    const iconPath = join(iconsDir, `${slug}.png`);
    if (existsSync(iconPath)) {
      const stat = statSync(iconPath);
      const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      return c.json({
        iconUrl: `/files/system/icons/${slug}.png`,
        etag,
        generated: false,
        alreadyExists: true,
      });
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
      iconStyle = "Digital neo-classic app icon filling the entire frame edge to edge, dark matte background with subtle luminous grid lines, clean geometric 3D forms, soft phosphor glow accents, rounded square shape, premium minimalist design, no margins or padding";
    }

    const client = createImageClient("test-key");
    const name = slug.replace(/-/g, " ").replace(/_/g, " ");
    const prompt = `App icon for '${name}': ${iconStyle}, no text, 1:1 square`;
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

  it("uses default neo-classic icon style when no desktop.json", async () => {
    const res = await app.request("/api/apps/timer/icon", { method: "POST" });
    const body = await res.json() as { prompt: string };
    expect(body.prompt).toContain("Digital neo-classic app icon");
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
    expect(body.prompt).not.toContain("Digital neo-classic");
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

  it("returns existing icon without regenerating when icon already exists", async () => {
    const res1 = await app.request("/api/apps/calculator/icon", {
      method: "POST",
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { iconUrl: string; cost: number };
    expect(body1.iconUrl).toBe("/files/system/icons/calculator.png");
    expect(typeof body1.cost).toBe("number");

    const res2 = await app.request("/api/apps/calculator/icon", {
      method: "POST",
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { iconUrl: string; alreadyExists: boolean; cost?: number };
    expect(body2.iconUrl).toBe("/files/system/icons/calculator.png");
    expect(body2.alreadyExists).toBe(true);
    expect(body2.cost).toBeUndefined();
  });

  it("generates different icons independently then locks both", async () => {
    await app.request("/api/apps/notes/icon", { method: "POST" });
    await app.request("/api/apps/timer/icon", { method: "POST" });

    expect(existsSync(join(homePath, "system/icons/notes.png"))).toBe(true);
    expect(existsSync(join(homePath, "system/icons/timer.png"))).toBe(true);

    const res1 = await app.request("/api/apps/notes/icon", { method: "POST" });
    const body1 = await res1.json() as { alreadyExists: boolean };
    expect(body1.alreadyExists).toBe(true);

    const res2 = await app.request("/api/apps/timer/icon", { method: "POST" });
    const body2 = await res2.json() as { alreadyExists: boolean };
    expect(body2.alreadyExists).toBe(true);
  });
});
