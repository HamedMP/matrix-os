import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createSettingsRoutes } from "../../packages/gateway/src/routes/settings.js";

function stubChannelManager() {
  return {
    status: () => ({}),
    start: async () => {},
    stop: async () => {},
    send: () => {},
    replay: async () => {},
  };
}

describe("Settings: desktop + theme + wallpapers", () => {
  let homePath: string;
  let app: Hono;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "settings-desktop-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(join(homePath, "system/config.json"), "{}");
    const routes = createSettingsRoutes({
      homePath,
      channelManager: stubChannelManager() as any,
    });
    app = new Hono();
    app.route("/api/settings", routes);
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  // --- GET /api/settings/desktop ---

  describe("GET /desktop", () => {
    it("returns defaults when desktop.json is missing", async () => {
      const res = await app.request("/api/settings/desktop");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.background).toEqual({ type: "pattern" });
      expect(data.dock).toEqual({
        position: "left",
        size: 56,
        iconSize: 40,
        autoHide: false,
      });
    });

    it("returns saved config when desktop.json exists", async () => {
      const config = {
        background: { type: "solid", color: "#ff0000" },
        dock: { position: "bottom", size: 64, iconSize: 48, autoHide: true },
      };
      writeFileSync(
        join(homePath, "system/desktop.json"),
        JSON.stringify(config),
      );
      const res = await app.request("/api/settings/desktop");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.background.type).toBe("solid");
      expect(data.dock.position).toBe("bottom");
    });
  });

  // --- PUT /api/settings/desktop ---

  describe("PUT /desktop", () => {
    it("writes valid config to disk", async () => {
      const config = {
        background: { type: "gradient", from: "#000", to: "#fff" },
        dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
      };
      const res = await app.request("/api/settings/desktop", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const saved = JSON.parse(
        readFileSync(join(homePath, "system/desktop.json"), "utf-8"),
      );
      expect(saved.background.type).toBe("gradient");
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/settings/desktop", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      });
      expect(res.status).toBe(400);
    });
  });

  // --- GET /api/settings/theme ---

  describe("GET /theme", () => {
    it("returns defaults when theme.json is missing", async () => {
      const res = await app.request("/api/settings/theme");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toBeDefined();
    });

    it("returns saved theme from disk", async () => {
      const theme = { name: "midnight", primary: "#0066ff" };
      writeFileSync(
        join(homePath, "system/theme.json"),
        JSON.stringify(theme),
      );
      const res = await app.request("/api/settings/theme");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("midnight");
      expect(data.primary).toBe("#0066ff");
    });
  });

  // --- PUT /api/settings/theme ---

  describe("PUT /theme", () => {
    it("writes theme to disk", async () => {
      const theme = { name: "sunset", primary: "#ff6600", accent: "#ff9900" };
      const res = await app.request("/api/settings/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(theme),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const saved = JSON.parse(
        readFileSync(join(homePath, "system/theme.json"), "utf-8"),
      );
      expect(saved.name).toBe("sunset");
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/settings/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "bad{{{",
      });
      expect(res.status).toBe(400);
    });
  });

  // --- GET /api/settings/wallpapers ---

  describe("GET /wallpapers", () => {
    it("returns empty array when wallpapers dir is missing", async () => {
      const res = await app.request("/api/settings/wallpapers");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    it("lists files when wallpapers exist", async () => {
      const wpDir = join(homePath, "system/wallpapers");
      mkdirSync(wpDir, { recursive: true });
      writeFileSync(join(wpDir, "forest.jpg"), "fake-image-data");
      writeFileSync(join(wpDir, "ocean.png"), "fake-image-data");

      const res = await app.request("/api/settings/wallpapers");
      expect(res.status).toBe(200);
      const data = await res.json() as { name: string; url: string }[];
      expect(data).toHaveLength(2);
      const names = data.map((w) => w.name).sort();
      expect(names).toEqual(["forest.jpg", "ocean.png"]);
      expect(data[0].url).toContain("/files/system/wallpapers/");
    });
  });

  // --- POST /api/settings/wallpaper ---

  describe("POST /wallpaper", () => {
    it("creates file from base64 data", async () => {
      const imageData = Buffer.from("fake-png-data").toString("base64");
      const res = await app.request("/api/settings/wallpaper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test.png", data: imageData }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      const filePath = join(homePath, "system/wallpapers/test.png");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath);
      expect(content.toString()).toBe("fake-png-data");
    });

    it("rejects path traversal in name", async () => {
      const imageData = Buffer.from("evil").toString("base64");
      const res = await app.request("/api/settings/wallpaper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "../../../etc/passwd", data: imageData }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects names with invalid characters", async () => {
      const imageData = Buffer.from("evil").toString("base64");
      const res = await app.request("/api/settings/wallpaper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test file!@#.png", data: imageData }),
      });
      expect(res.status).toBe(400);
    });
  });

  // --- DELETE /api/settings/wallpaper/:name ---

  describe("DELETE /wallpaper/:name", () => {
    it("removes an existing wallpaper file", async () => {
      const wpDir = join(homePath, "system/wallpapers");
      mkdirSync(wpDir, { recursive: true });
      writeFileSync(join(wpDir, "old.jpg"), "data");

      const res = await app.request("/api/settings/wallpaper/old.jpg", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(existsSync(join(wpDir, "old.jpg"))).toBe(false);
    });

    it("returns 404 for missing wallpaper", async () => {
      const res = await app.request("/api/settings/wallpaper/nonexistent.png", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("rejects path traversal in name", async () => {
      const res = await app.request(
        "/api/settings/wallpaper/..%2F..%2Fetc%2Fpasswd",
        { method: "DELETE" },
      );
      expect(res.status).toBe(400);
    });
  });
});
