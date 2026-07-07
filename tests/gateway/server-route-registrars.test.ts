import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { registerAppRuntimeRoutes } from "../../packages/gateway/src/server/app-runtime-routes.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";

describe("gateway server route registrars", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("wires app runtime boundary validation through the extracted registrar", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-app-routes-"));
    cleanupPaths.push(homePath);
    const app = new Hono();
    const processManager = registerAppRuntimeRoutes(app, {
      homePath,
      appSessionMasterSecret: "test-secret-with-enough-entropy",
      devAppAuthBypass: true,
      publicHost: "localhost",
      onAppError: () => {},
    });

    try {
      const res = await app.request("/api/apps/bad!/manifest");

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid slug" });
    } finally {
      await processManager.shutdownAll();
    }
  });

  it("wires file route query validation through the extracted registrar", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "gateway-file-routes-"));
    cleanupPaths.push(homePath);
    const app = new Hono();
    registerFileRoutes(app, { homePath });

    const res = await app.request("/api/files/search");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "q required" });
  });
});
