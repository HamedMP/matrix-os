import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSettingsRoutes } from "../../packages/gateway/src/server/settings-routes.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(osViewState: Parameters<typeof registerSettingsRoutes>[0]["osViewState"]) {
  const homePath = mkdtempSync(join(tmpdir(), "settings-routes-"));
  homes.push(homePath);
  const app = new Hono();
  const settingsRoutes = new Hono().get("/appearance", (c) => c.json({ theme: "light" }));
  registerSettingsRoutes({ app, homePath, settingsRoutes, getStartedEnabled: false, getOwnerId: () => "owner", botServices: null, osViewState });
  return app;
}

describe("settings route registration", () => {
  it("mounts Get started ahead of the general settings routes", async () => {
    const app = setup(null);
    expect(await (await app.request("/api/settings/get-started")).json()).toEqual({ status: "not_eligible" });
    expect(await (await app.request("/api/settings/appearance")).json()).toEqual({ theme: "light" });
  });

  it("reports OS-view state as unavailable without a repository, and serves it with one", async () => {
    expect((await setup(null).request("/api/os-view-state")).status).toBe(503);
    const repository = { getOrCreate: vi.fn(async () => ({ revision: 1 }) as never), importLegacyDesktop: vi.fn(), patch: vi.fn() };
    const response = await setup({ repository, getOwnerId: () => "owner" }).request("/api/os-view-state");
    expect(response.status).toBe(200);
    expect(repository.getOrCreate).toHaveBeenCalledWith("owner");
  });
});
