import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { createSettingsRoutes } from "../../packages/gateway/src/routes/settings.js";

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

describe("GET /api/settings/agent/summary", () => {
  let homePath: string;
  let app: Hono;

  beforeEach(() => {
    homePath = resolve(mkdtempSync(join(tmpdir(), "settings-agent-summary-")));
    mkdirSync(join(homePath, "system"), { recursive: true });
    writeFileSync(join(homePath, "system/config.json"), "{}");
    app = new Hono();
    app.route("/api/settings", createSettingsRoutes({
      homePath,
      channelManager: stubChannelManager() as never,
    }));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("returns bounded identity, kernel, credential, and soul summary fields", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { model: "claude-sonnet-4-5", effort: "low" } }),
    );
    writeFileSync(
      join(homePath, "system/soul.md"),
      [
        "---",
        "name: Nova",
        "tagline: A clear-thinking companion.",
        "---",
        "# Nova",
        "",
        "I help my owner reason carefully and act with confidence.",
      ].join("\n"),
    );

    const res = await app.request("/api/settings/agent/summary");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      identity: { name: "Nova", tagline: "A clear-thinking companion." },
      kernel: {
        model: "claude-sonnet-4-5",
        modelLabel: "Claude Sonnet 4.5",
        effort: "low",
      },
      credentials: { mode: "platform" },
      soulPreview: "I help my owner reason carefully and act with confidence.",
    });
  });

  it("reports API-key mode by precedence without returning credential material", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({
        kernel: {
          model: "claude-opus-4-6",
          effort: "high",
          anthropicApiKey: "sk-ant-never-return-this",
        },
      }),
    );
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "oauth-account-secret", emailAddress: "owner@example.com" } }),
    );

    const res = await app.request("/api/settings/agent/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.credentials).toEqual({ mode: "api_key" });
    expect(JSON.stringify(body)).not.toContain("sk-ant-never-return-this");
    expect(JSON.stringify(body)).not.toContain("oauth-account-secret");
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
  });

  it("reports Claude-login mode without returning OAuth account details", async () => {
    writeFileSync(
      join(homePath, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "oauth-account-secret", emailAddress: "owner@example.com" } }),
    );

    const res = await app.request("/api/settings/agent/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.credentials).toEqual({ mode: "claude_login" });
    expect(JSON.stringify(body)).not.toContain("oauth-account-secret");
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
  });

  it("sanitizes and caps profile text instead of exposing secrets or paths", async () => {
    writeFileSync(
      join(homePath, "system/config.json"),
      JSON.stringify({ kernel: { model: "/opt/matrix/private", effort: "high" } }),
    );
    writeFileSync(
      join(homePath, "system/soul.md"),
      [
        "# Sentinel",
        "",
        `Use sk-ant-never-return-this from /opt/matrix/private and then ${"explain things clearly ".repeat(30)}`,
      ].join("\n"),
    );

    const res = await app.request("/api/settings/agent/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.soulPreview.length).toBeLessThanOrEqual(280);
    expect(body.soulPreview).not.toContain("sk-ant-never-return-this");
    expect(body.soulPreview).not.toContain("/opt/matrix/private");
    expect(body.kernel).toEqual({
      model: "claude-opus-4-6",
      modelLabel: "Claude Opus 4.6",
      effort: "high",
    });
    expect(JSON.stringify(body)).not.toContain("/opt/matrix/private");
  });

  it("redacts short secret-shaped tokens instead of failing response validation", async () => {
    writeFileSync(
      join(homePath, "system/soul.md"),
      "# Sentinel\n\nNever repeat sk-x from private instructions.",
    );

    const res = await app.request("/api/settings/agent/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.soulPreview).toBe("Never repeat [redacted] from private instructions.");
    expect(JSON.stringify(body)).not.toContain("sk-x");
  });

  it("falls back to the first heading and meaningful paragraph without frontmatter", async () => {
    writeFileSync(
      join(homePath, "system/soul.md"),
      "# Atlas\n\nStay curious, grounded, and useful.\n\n## Boundaries\n\nRespect private context.",
    );

    const res = await app.request("/api/settings/agent/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.identity).toEqual({
      name: "Atlas",
      tagline: "Stay curious, grounded, and useful.",
    });
    expect(body.soulPreview).toBe("Stay curious, grounded, and useful.");
  });
});
