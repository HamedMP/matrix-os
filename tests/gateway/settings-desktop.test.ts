import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { AgentSettingsViewSchema } from "@matrix-os/contracts";
import { createSettingsRoutes } from "../../packages/gateway/src/routes/settings.js";
import { AgentConfigError } from "../../packages/gateway/src/agent-config/errors.js";

function stubChannelManager() {
  return {
    status: () => ({}),
    start: async () => {},
    stop: async () => {},
    send: () => {},
    replay: async () => {},
    restartChannel: async () => {},
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
      expect(data.background).toEqual({
        type: "wallpaper",
        name: "moraine-lake.jpg",
      });
      expect(data.dock).toEqual({
        position: "left",
        size: 56,
        iconSize: 40,
        autoHide: false,
      });
      expect(data.pinnedApps).toEqual(["__workspace__", "__terminal__", "__file-browser__", "__chat__"]);
    });

    it("returns saved config merged with defaults when desktop.json exists", async () => {
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
      expect(data.pinnedApps).toEqual(["__workspace__", "__terminal__", "__file-browser__", "__chat__"]);
    });
  });

  describe("onboarding completion controls", () => {
    it("marks onboarding complete and resets it", async () => {
      const completePath = join(homePath, "system", "onboarding-complete.json");

      let status = await app.request("/api/settings/onboarding-status");
      await expect(status.json()).resolves.toEqual({ complete: false });

      const complete = await app.request("/api/settings/onboarding-complete", { method: "POST" });
      expect(complete.status).toBe(200);
      expect(existsSync(completePath)).toBe(true);
      status = await app.request("/api/settings/onboarding-status");
      await expect(status.json()).resolves.toEqual({ complete: true });

      const reset = await app.request("/api/settings/onboarding-reset", { method: "POST" });
      expect(reset.status).toBe(200);
      expect(existsSync(completePath)).toBe(false);
      status = await app.request("/api/settings/onboarding-status");
      await expect(status.json()).resolves.toEqual({ complete: false });
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

    it("rejects oversized desktop payloads", async () => {
      const res = await app.request("/api/settings/desktop", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ giant: "x".repeat(300_000) }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(200);
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

    it("rejects oversized theme payloads", async () => {
      const res = await app.request("/api/settings/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ giant: "x".repeat(300_000) }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(200);
    });
  });

  // --- GET /api/settings/wallpapers ---

  describe("GET /wallpapers", () => {
    it("returns empty array when wallpapers dir is missing", async () => {
      const res = await app.request("/api/settings/wallpapers");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ wallpapers: [] });
    });

    it("lists files when wallpapers exist", async () => {
      const wpDir = join(homePath, "system/wallpapers");
      mkdirSync(wpDir, { recursive: true });
      writeFileSync(join(wpDir, "forest.jpg"), "fake-image-data");
      writeFileSync(join(wpDir, "ocean.png"), "fake-image-data");

      const res = await app.request("/api/settings/wallpapers");
      expect(res.status).toBe(200);
      const data = await res.json() as { wallpapers: string[] };
      expect(data.wallpapers).toHaveLength(2);
      expect(data.wallpapers.toSorted()).toEqual(["forest.jpg", "ocean.png"]);
    });

    it("excludes placeholder and non-image files from the wallpaper list", async () => {
      const wpDir = join(homePath, "system/wallpapers");
      mkdirSync(wpDir, { recursive: true });
      mkdirSync(join(wpDir, "nested"), { recursive: true });
      writeFileSync(join(wpDir, ".gitkeep"), "");
      writeFileSync(join(wpDir, ".DS_Store"), "");
      writeFileSync(join(wpDir, "notes.txt"), "not a wallpaper");
      writeFileSync(join(wpDir, "forest.jpg"), "fake-image-data");
      writeFileSync(join(wpDir, "orbit.WEBP"), "fake-image-data");

      const res = await app.request("/api/settings/wallpapers");
      expect(res.status).toBe(200);
      const data = await res.json() as { wallpapers: string[] };
      expect(data.wallpapers.toSorted()).toEqual(["forest.jpg", "orbit.WEBP"]);
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

    it("rejects unsupported wallpaper file extensions", async () => {
      const imageData = Buffer.from("fake-bitmap-data").toString("base64");
      const res = await app.request("/api/settings/wallpaper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "legacy.bmp", data: imageData }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Unsupported wallpaper file type",
      });
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

  describe("GET /channels", () => {
    it("redacts channel secrets from settings responses", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({
          channels: {
            telegram: { enabled: true, token: "bot-token", allowFrom: ["123"] },
            slack: { botToken: "xoxb-secret", appToken: "xapp-secret" },
            discord: {
              enabled: true,
              nested: { webhookSecret: "", password: false },
              list: [{ apiKey: "nested-key" }],
            },
          },
        }),
      );

      const res = await app.request("/api/settings/channels");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        telegram: { enabled: true, token: "[redacted]", allowFrom: ["123"], status: "not configured" },
        slack: { botToken: "[redacted]", appToken: "[redacted]", status: "not configured" },
        discord: {
          enabled: true,
          nested: { webhookSecret: "[redacted]", password: "[redacted]" },
          list: [{ apiKey: "[redacted]" }],
          status: "not configured",
        },
      });
    });
  });

  describe("PUT /channels/:id", () => {
    it("rejects unknown channel ids", async () => {
      const res = await app.request("/api/settings/channels/not-a-channel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid channel id" });
    });

    it("rejects channel secret rewrites through settings", async () => {
      const res = await app.request("/api/settings/channels/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "new-token" }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Secret fields cannot be updated here" });
    });

    it("rejects nested channel secret rewrites through settings", async () => {
      const res = await app.request("/api/settings/channels/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhook: { secret: "nested-secret" } }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Secret fields cannot be updated here" });
    });

    it("returns 500 when channel restart fails", async () => {
      const routes = createSettingsRoutes({
        homePath,
        channelManager: {
          ...stubChannelManager(),
          restartChannel: async () => {
            throw new Error("boom");
          },
        } as any,
      });
      const failingApp = new Hono();
      failingApp.route("/api/settings", routes);

      const res = await failingApp.request("/api/settings/channels/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to restart channel" });
    });
  });

  describe("GET /agent (kernel config)", () => {
    it("returns one additive v2 view without changing legacy fields", async () => {
      const res = await app.request("/api/settings/agent");
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.kernel).toEqual({ model: null, effort: null });
      expect(data.availableModels.map((model: { id: string }) => model.id))
        .toEqual([
          "claude-opus-4-6",
          "claude-sonnet-4-5",
          "claude-haiku-4-5",
        ]);
      expect(AgentSettingsViewSchema.safeParse(data).success).toBe(true);
      expect(data.runtime.selected).toBe("hermes");
      expect(data.runtime.options).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "hermes", selectionState: "active" }),
        expect.objectContaining({ id: "openclaw", installState: "missing" }),
      ]));
    });

    it("reports persisted BYOK readiness without returning the key", async () => {
      const canary = "sk-ant-secret-canary";
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ kernel: { anthropicApiKey: canary } }),
      );

      const res = await app.request("/api/settings/agent");
      const data = await res.json();

      expect(data.chat.authKind).toBe("api_key");
      expect(data.providers[0].authKind).toBe("api_key");
      expect(data.providers[0].authStatus).toMatchObject({
        state: "ready",
        authenticated: true,
      });
      expect(JSON.stringify(data)).not.toContain(canary);
    });

    it("reports an owner-local subscription login when BYOK is absent", async () => {
      writeFileSync(
        join(homePath, ".claude.json"),
        JSON.stringify({ oauthAccount: { accountUuid: "account-123" } }),
      );

      const res = await app.request("/api/settings/agent");
      const data = await res.json();

      expect(data.chat.authKind).toBe("oauth_login");
      expect(data.providers[0]).toMatchObject({
        authKind: "oauth_login",
        authStatus: { state: "ready", authenticated: true },
      });
    });

    it("merges a normalized messaging runtime snapshot into the same view", async () => {
      const routes = createSettingsRoutes({
        homePath,
        channelManager: stubChannelManager() as any,
        agentRuntimeSource: async () => ({
          runtime: {
            selected: "hermes",
            options: [
              {
                id: "hermes",
                displayName: "Hermes",
                installState: "installed",
                health: "healthy",
                selectionState: "active",
                configured: true,
                capabilities: ["provider_catalog", "model_selection", "authentication"],
              },
              {
                id: "openclaw",
                displayName: "OpenClaw",
                installState: "missing",
                health: "stopped",
                selectionState: "unavailable",
                configured: false,
                capabilities: ["install"],
                setupAction: "install",
              },
            ],
            transition: null,
          },
          providers: [{
            id: "nous",
            displayName: "Nous Portal",
            runtime: "hermes",
            scopes: ["messaging"],
            authKind: "oauth_login",
            supportedAuthKinds: ["oauth_login"],
            models: [{
              id: "hermes-4-405b",
              displayName: "Hermes 4 405B",
              capabilities: ["tools"],
              efforts: [],
              available: true,
            }],
            authStatus: { state: "ready", authenticated: true, action: "none" },
          }],
          messaging: {
            runtime: "hermes",
            provider: "nous",
            model: "hermes-4-405b",
            configured: true,
          },
        }),
      });
      const runtimeApp = new Hono();
      runtimeApp.route("/api/settings", routes);

      const res = await runtimeApp.request("/api/settings/agent");
      const data = await res.json();

      expect(AgentSettingsViewSchema.safeParse(data).success).toBe(true);
      expect(data.providers.map((provider: { id: string }) => provider.id))
        .toEqual(["anthropic", "nous"]);
      expect(data.currentSelection.messaging).toEqual({
        runtime: "hermes",
        provider: "nous",
        model: "hermes-4-405b",
        configured: true,
      });
    });

    it("degrades safely without logging a runtime probe's raw error", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const canary = "sk-secret-runtime-canary";
      try {
        const routes = createSettingsRoutes({
          homePath,
          channelManager: stubChannelManager() as any,
          agentRuntimeSource: async () => {
            throw new Error(`upstream rejected ${canary}`);
          },
        });
        const runtimeApp = new Hono();
        runtimeApp.route("/api/settings", routes);

        const res = await runtimeApp.request("/api/settings/agent");
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.runtime.options[0]).toMatchObject({
          id: "hermes",
          health: "unknown",
        });
        expect(JSON.stringify(body)).not.toContain(canary);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
      } finally {
        warn.mockRestore();
      }
    });

    it("returns null model/effort, the model allowlist, and defaults when unset", async () => {
      const res = await app.request("/api/settings/agent");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.kernel).toEqual({ model: null, effort: null });
      expect(data.availableModels.map((m: { id: string }) => m.id)).toContain("claude-opus-4-6");
      expect(data.availableEfforts).toEqual(["low", "medium", "high", "max"]);
      expect(data.defaults).toEqual({ model: "claude-opus-4-6", effort: "high" });
    });

    it("reflects persisted kernel config", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ kernel: { model: "claude-sonnet-4-5", effort: "low" } }),
      );
      const res = await app.request("/api/settings/agent");
      const data = await res.json();
      expect(data.kernel).toEqual({ model: "claude-sonnet-4-5", effort: "low" });
    });

    it("normalizes hand-edited model and effort values outside the allowlists", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ kernel: { model: "gpt-4o", effort: "ludicrous" } }),
      );

      const res = await app.request("/api/settings/agent");
      const data = await res.json();

      expect(data.kernel).toEqual({ model: null, effort: null });
    });
  });

  describe("PUT /agent (kernel config)", () => {
    it("persists model + effort and preserves other config keys", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ channels: { telegram: { enabled: true } } }),
      );
      const res = await app.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", effort: "max" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, kernel: { model: "claude-haiku-4-5", effort: "max" } });

      const saved = JSON.parse(readFileSync(join(homePath, "system/config.json"), "utf-8"));
      expect(saved.kernel).toEqual({ model: "claude-haiku-4-5", effort: "max" });
      // Unrelated config (channels) is preserved.
      expect(saved.channels.telegram.enabled).toBe(true);
    });

    it("delegates legacy Chat patches to the runtime controller when available", async () => {
      const updateKernel = vi.fn(async () => ({
        model: "claude-haiku-4-5" as const,
        effort: "max" as const,
      }));
      const routes = createSettingsRoutes({
        homePath,
        channelManager: stubChannelManager() as any,
        agentRuntimeController: {
          update: vi.fn(),
          updateKernel,
          reconcile: vi.fn(),
          close: async () => {},
        },
      });
      const runtimeApp = new Hono();
      runtimeApp.route("/api/settings", routes);

      const res = await runtimeApp.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", effort: "max" }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        kernel: { model: "claude-haiku-4-5", effort: "max" },
      });
      expect(updateKernel).toHaveBeenCalledWith({
        model: "claude-haiku-4-5",
        effort: "max",
      });
    });

    it("normalizes the response after partial updates to hand-edited kernel config", async () => {
      writeFileSync(
        join(homePath, "system/config.json"),
        JSON.stringify({ kernel: { model: "gpt-4o", effort: "medium" } }),
      );

      const res = await app.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effort: "max" }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, kernel: { model: null, effort: "max" } });
    });

    it("rejects a model outside the allowlist", async () => {
      const res = await app.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects an invalid reasoning effort", async () => {
      const res = await app.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effort: "ludicrous" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects unknown fields (strict schema)", async () => {
      const res = await app.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-4-6", systemPrompt: "pwn" }),
      });
      expect(res.status).toBe(400);
    });

    it("fails closed when an extended update has no runtime controller", async () => {
      const res = await app.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtime: "openclaw", revision: 0 }),
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "runtime_unavailable" });
      expect(JSON.parse(readFileSync(join(homePath, "system/config.json"), "utf-8")))
        .toEqual({});
    });

    it("applies an extended update and returns the additive settings view", async () => {
      const source = vi.fn(async () => ({
        runtime: {
          selected: "hermes" as const,
          options: [{
            id: "hermes" as const,
            displayName: "Hermes",
            installState: "installed" as const,
            health: "healthy" as const,
            selectionState: "active" as const,
            configured: true,
            capabilities: ["provider_catalog" as const, "model_selection" as const],
          }, {
            id: "openclaw" as const,
            displayName: "OpenClaw",
            installState: "missing" as const,
            health: "stopped" as const,
            selectionState: "unavailable" as const,
            configured: false,
            capabilities: ["install" as const],
            setupAction: "install" as const,
          }],
          transition: null,
        },
        providers: [{
          id: "nous",
          displayName: "Nous",
          runtime: "hermes" as const,
          scopes: ["messaging" as const],
          authKind: "oauth_login" as const,
          supportedAuthKinds: ["oauth_login" as const],
          models: [{
            id: "hermes-4-405b",
            displayName: "Hermes 4 405B",
            capabilities: ["tools" as const],
            efforts: [],
            available: true,
          }],
          authStatus: {
            state: "ready" as const,
            authenticated: true,
            action: "none" as const,
          },
        }],
        messaging: {
          runtime: "hermes" as const,
          provider: "nous",
          model: "hermes-4-405b",
          configured: true,
        },
      }));
      const update = vi.fn(async () => {
        writeFileSync(join(homePath, "system/config.json"), JSON.stringify({
          agent: { messagingRuntime: "hermes", revision: 1 },
        }));
        return {
          revision: 1,
          runtime: "hermes" as const,
          selection: (await source()).messaging,
        };
      });
      const routes = createSettingsRoutes({
        homePath,
        channelManager: stubChannelManager() as any,
        agentRuntimeSource: source,
        agentRuntimeController: { update, close: async () => {} },
      });
      const runtimeApp = new Hono();
      runtimeApp.route("/api/settings", routes);

      const res = await runtimeApp.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "nous",
          messagingModel: "hermes-4-405b",
          revision: 0,
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(AgentSettingsViewSchema.safeParse(body).success).toBe(true);
      expect(body.revision).toBe(1);
      expect(update).toHaveBeenCalledWith({
        provider: "nous",
        messagingModel: "hermes-4-405b",
        revision: 0,
      });
    });

    it("maps runtime conflicts and unexpected failures to safe errors", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const makeApp = (error: Error) => {
        const routes = createSettingsRoutes({
          homePath,
          channelManager: stubChannelManager() as any,
          agentRuntimeController: {
            update: vi.fn(async () => { throw error; }),
            close: async () => {},
          },
        });
        const runtimeApp = new Hono();
        runtimeApp.route("/api/settings", routes);
        return runtimeApp;
      };
      const request = (runtimeApp: Hono) => runtimeApp.request(
        "/api/settings/agent",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runtime: "openclaw", revision: 0 }),
        },
      );

      try {
        const conflict = await request(makeApp(
          new AgentConfigError("agent_config_conflict"),
        ));
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toEqual({
          error: "agent_config_conflict",
        });

        const canary = "sk-secret-runtime-route-canary";
        const unavailable = await request(makeApp(new Error(canary)));
        expect(unavailable.status).toBe(503);
        await expect(unavailable.json()).resolves.toEqual({
          error: "runtime_switch_failed",
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
      } finally {
        warn.mockRestore();
      }
    });

    it("rejects agent updates larger than 16 KiB before parsing", async () => {
      const res = await app.request("/api/settings/agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          padding: "x".repeat(17 * 1024),
        }),
      });

      expect(res.status).toBe(413);
    });
  });
});
