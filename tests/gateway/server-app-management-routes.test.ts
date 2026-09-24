import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { registerAppManagementRoutes } from "../../packages/gateway/src/server/app-management-routes.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

async function createApp() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-app-routes-"));
  homes.push(homePath);
  await mkdir(join(homePath, "apps"));
  const app = new Hono();
  registerAppManagementRoutes(app, { homePath });
  return app;
}

describe("gateway app management route registration", () => {
  it("registers the app catalog and rejects an invalid icon slug", async () => {
    const app = await createApp();
    const catalog = await app.request("/api/apps");
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual([]);
    const invalidIcon = await app.request("/api/apps/bad.slug/icon", { method: "POST" });
    expect(invalidIcon.status).toBe(400);
    expect(await invalidIcon.json()).toEqual({ error: "Invalid slug" });
  });

  it("limits DELETE request bodies before app deletion", async () => {
    const app = await createApp();
    const response = await app.request("/api/apps/absent", {
      method: "DELETE",
      headers: { "content-type": "text/plain", "content-length": "4097" },
      body: "x".repeat(4097),
    });
    expect(response.status).toBe(413);
  });

  it("rejects a non-string rename payload at the route boundary", async () => {
    const app = await createApp();
    const response = await app.request("/api/apps/notes/rename", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
  });

  it("rejects a malformed rename body without surfacing a parser failure", async () => {
    const app = await createApp();
    const response = await app.request("/api/apps/notes/rename", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("rejects an invalid slug on rename before touching the filesystem", async () => {
    const app = await createApp();
    const response = await app.request("/api/apps/bad.slug/rename", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid slug" });
  });

  it("rejects a non-string icon style at the route boundary", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const app = await createApp();
    const response = await app.request("/api/apps/notes/icon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style: { evil: true } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
  });
});
