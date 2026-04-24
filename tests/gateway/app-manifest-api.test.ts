import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTestGateway, type TestGateway } from "../helpers/gateway.js";
import { invalidateManifestCache } from "../../packages/gateway/src/app-runtime/manifest-loader.js";

let gateway: TestGateway;

beforeEach(async () => {
  invalidateManifestCache();
  gateway = await buildTestGateway();
});

afterEach(async () => {
  await gateway.stop();
  await rm(gateway.home, { recursive: true, force: true });
});

describe("GET /api/apps/:slug/manifest", () => {
  it("returns manifest + runtimeState ready for static app", async () => {
    await gateway.installAppFromFixture("calculator-static");
    const res = await gateway.app.request("/api/apps/calculator-static/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.runtime).toBe("static");
    expect(body.runtimeState.status).toBe("ready");
    expect(body.distributionStatus).toBe("installable");
  });

  it("returns runtimeState ready for built vite app", async () => {
    await gateway.installAppFromFixture("hello-vite");
    const res = await gateway.app.request("/api/apps/hello-vite/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.runtime).toBe("vite");
    expect(body.runtimeState.status).toBe("ready");
  }, 120_000);

  it("returns runtimeState needs_build when .build-stamp is missing", async () => {
    const appDir = join(gateway.home, "apps", "unbuilt");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "matrix.json"),
      JSON.stringify({
        name: "Unbuilt",
        slug: "unbuilt",
        version: "1.0.0",
        runtime: "vite",
        runtimeVersion: "^1.0.0",
        listingTrust: "first_party",
        build: { command: "pnpm build", output: "dist" },
      }),
    );
    invalidateManifestCache();
    const res = await gateway.app.request("/api/apps/unbuilt/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimeState.status).toBe("needs_build");
  });

  it("returns distributionStatus blocked for community tier (production default)", async () => {
    const appDir = join(gateway.home, "apps", "community-app");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "matrix.json"),
      JSON.stringify({
        name: "Community App",
        slug: "community-app",
        version: "1.0.0",
        runtime: "static",
        runtimeVersion: "^1.0.0",
        listingTrust: "community",
      }),
    );
    invalidateManifestCache();
    const res = await gateway.app.request("/api/apps/community-app/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.distributionStatus).toBe("blocked");
  });

  it("returns 404 for missing app", async () => {
    const res = await gateway.app.request("/api/apps/nonexistent/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid slug", async () => {
    const res = await gateway.app.request("/api/apps/-bad/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 without auth header", async () => {
    const res = await gateway.app.request("/api/apps/calculator-static/manifest");
    expect(res.status).toBe(401);
  });
});
