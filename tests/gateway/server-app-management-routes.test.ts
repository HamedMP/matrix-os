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
});
