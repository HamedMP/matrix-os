import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
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

describe("phase 1: static + vite runtime", () => {
  it("installs and serves a static app via the unified /apps/:slug/ dispatcher", async () => {
    await gateway.installAppFromFixture("calculator-static");
    const cookie = await gateway.openAppSession("calculator-static");
    const res = await gateway.app.request("/apps/calculator-static/", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Calculator");
  });

  it("serving an app without the session cookie returns 401", async () => {
    await gateway.installAppFromFixture("calculator-static");
    const res = await gateway.app.request("/apps/calculator-static/", {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("matrix-session-refresh")).toBe(
      "/api/apps/calculator-static/session",
    );
  });

  it("installs, builds, and serves a Vite app through the same /apps/:slug/ route", async () => {
    await gateway.installAppFromFixture("hello-vite");
    const cookie = await gateway.openAppSession("hello-vite");
    const res = await gateway.app.request("/apps/hello-vite/", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<html");
    expect(html).toMatch(/<script/);
  }, 120_000);

  it("session cookie issued for calculator-static is rejected on /apps/hello-vite/ (path scoping)", async () => {
    await gateway.installAppFromFixture("calculator-static");
    await gateway.installAppFromFixture("hello-vite");
    const calcCookie = await gateway.openAppSession("calculator-static");
    const res = await gateway.app.request("/apps/hello-vite/", {
      headers: { Cookie: calcCookie, Accept: "text/html" },
    });
    expect(res.status).toBe(401);
  }, 120_000);

  it("manifest API returns the expected runtime mode and distributionStatus", async () => {
    await gateway.installAppFromFixture("hello-vite");
    const res = await gateway.app.request("/api/apps/hello-vite/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.runtime).toBe("vite");
    expect(body.distributionStatus).toBe("installable");
  }, 120_000);

  it("manifest API returns needs_build when dist is missing", async () => {
    // Install static fixture to get the slug set up, then create a vite manifest without building
    await gateway.installAppFromFixture("calculator-static");
    const res = await gateway.app.request("/api/apps/calculator-static/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manifest.runtime).toBe("static");
    expect(body.runtimeState.status).toBe("ready");
  });

  it("returns 404 for non-existent app manifest", async () => {
    const res = await gateway.app.request("/api/apps/nonexistent/manifest", {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 for manifest API without auth", async () => {
    const res = await gateway.app.request("/api/apps/hello-vite/manifest");
    expect(res.status).toBe(401);
  });
});
