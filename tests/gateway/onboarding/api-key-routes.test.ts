import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createSettingsRoutes } from "../../../packages/gateway/src/routes/settings.js";

function stubChannelManager() {
  return {
    status: () => ({}),
    start: async () => {},
    stop: async () => {},
    send: () => {},
    replay: async () => {},
  };
}

describe("Settings: API key endpoints", () => {
  let homePath: string;
  let app: Hono;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "settings-apikey-")));
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
    vi.restoreAllMocks();
  });

  describe("GET /api/settings/api-key/status", () => {
    it("returns hasKey: false when no key stored", async () => {
      const res = await app.request("/api/settings/api-key/status");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ hasKey: false });
    });

    it("returns hasKey: true when key stored", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ kernel: { anthropicApiKey: "sk-ant-x" } }),
      );
      const res = await app.request("/api/settings/api-key/status");
      const data = await res.json();
      expect(data).toEqual({ hasKey: true });
    });
  });

  describe("POST /api/settings/api-key", () => {
    it("rejects missing apiKey", async () => {
      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("rejects invalid format", async () => {
      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "bad-key" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("validates and stores a valid key", async () => {
      // Mock the live validation fetch
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-valid123" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.valid).toBe(true);

      // Verify stored
      const config = JSON.parse(readFileSync(join(homePath, "system/config.json"), "utf-8"));
      expect(config.kernel.anthropicApiKey).toBe("sk-ant-valid123");
    });

    it("returns error when live validation fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const res = await app.request("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "sk-ant-invalid" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });
  });
});
