import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerAppRuntimeRoutes } from "../../packages/gateway/src/server/app-runtime-routes.js";
import { deriveAppSessionKey, signAppSession } from "../../packages/gateway/src/app-runtime/app-session.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = "browser-lab-wiring-test-32-bytes";
const managers: Array<ReturnType<typeof registerAppRuntimeRoutes>> = [];
const labs: Array<{ close(): void }> = [];
const homes: string[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) lab.close();
  for (const manager of managers.splice(0)) await manager.shutdownAll();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("browser lab runtime composition", () => {
  it("exchanges the native launch token before lab auth and serves authenticated entry assets", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "browser-lab-native-launch-"));
    homes.push(homePath);
    const appPath = join(homePath, "apps", "browser-lab");
    await mkdir(join(appPath, "assets"), { recursive: true });
    await writeFile(join(appPath, "matrix.json"), JSON.stringify({
      name: "Browser Lab", slug: "browser-lab", runtime: "static", version: "0.1.0",
      runtimeVersion: "^1.0.0", scope: "personal", listingTrust: "first_party",
    }));
    const entry = '<!doctype html><title>Browser Lab</title><script type="module" src="./assets/lab.js"></script>';
    await writeFile(join(appPath, "index.html"), entry);
    await writeFile(join(appPath, "assets", "lab.js"), 'document.title = "Browser Lab loaded";');
    vi.stubEnv("MATRIX_HANDLE", "pr-2526");
    const app = new Hono();
    managers.push(registerAppRuntimeRoutes(app, {
      homePath, appSessionMasterSecret: key, devAppAuthBypass: false,
      publicHost: "app.matrix-os.com", onAppError: () => {},
      browserLab: { enabled: true, isAllowedOrigin: () => true, onRegistered: (lab) => labs.push(lab) },
    }));
    const minted = await app.request("/api/apps/browser-lab/session-token", { method: "POST", body: "{}" });
    expect(minted.status).toBe(200);
    const { token, launchUrl } = await minted.json();
    expect(token).toMatch(/^pr-2526\.[A-Za-z0-9_-]+$/);
    const launched = await app.request(`https://app.matrix-os.com${launchUrl}`);
    expect(launched.status).toBe(302);
    expect(launched.headers.get("location")).toBe("/apps/browser-lab/");
    const rawCookie = launched.headers.get("set-cookie");
    expect(rawCookie).toContain("matrix_app_session__browser-lab=");
    expect(rawCookie).toContain("Path=/apps/browser-lab/");
    expect(rawCookie).toContain("HttpOnly");
    expect(rawCookie).toContain("Secure");
    const headers = { cookie: rawCookie!.split(";")[0] };
    const html = await app.request("/apps/browser-lab/", { headers });
    expect(html.status).toBe(200);
    expect(await html.text()).toBe(entry);
    const asset = await app.request("/apps/browser-lab/assets/lab.js", { headers });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("Browser Lab loaded");
    // Platform rewrites this module under /vm/<handle>, outside the root
    // launch cookie Path. It authenticates that read-only asset at the edge
    // and forwards the gateway's verified platform bearer, with no lab cookie.
    vi.stubEnv("MATRIX_AUTH_TOKEN", "synthetic-platform-asset-token");
    const platformHeaders = { authorization: "Bearer synthetic-platform-asset-token" };
    const platformAsset = await app.request("/apps/browser-lab/assets/lab.js", { headers: platformHeaders });
    expect(platformAsset.status).toBe(200);
    expect(await platformAsset.text()).toContain("Browser Lab loaded");
    expect((await app.request("/apps/browser-lab/assets/lab.js", { method: "HEAD", headers: platformHeaders })).status).toBe(200);
    expect((await app.request("/apps/browser-lab/assets/lab.js", { headers: { authorization: "Bearer wrong-token" } })).status).toBe(401);
    expect((await app.request("/apps/browser-lab/assets/lab.js", { method: "POST", headers: platformHeaders })).status).toBe(401);
    for (const path of ["/", "/api/status", "/api/viewer-session", "/viewer/", "/viewer/websockify"]) {
      expect((await app.request(`/apps/browser-lab${path}`, { headers: platformHeaders })).status).toBe(401);
    }
    expect((await app.request("/apps/browser-lab/api/control", { method: "POST", headers: platformHeaders, body: '{"action":"stop"}' })).status).toBe(401);
    vi.stubEnv("MATRIX_AUTH_TOKEN", "");
    expect((await app.request("/apps/browser-lab/assets/lab.js", { headers: platformHeaders })).status).toBe(401);
    expect((await app.request(launchUrl)).status).toBe(401);
    expect((await app.request("/apps/browser-lab/?session=pr-2526.invalid")).status).toBe(401);
    for (const path of ["/", "/assets/lab.js", "/api/status", "/viewer/"]) {
      expect((await app.request(`/apps/browser-lab${path}`)).status).toBe(401);
    }
  });
  it.each([false, true])("runs lab auth before generic app dispatch even with dev bypass %s", async (devAppAuthBypass) => {
    const app = new Hono();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ phase: "idle" }));
    managers.push(registerAppRuntimeRoutes(app, {
      homePath: "/nonexistent-browser-lab-test-home", appSessionMasterSecret: key,
      devAppAuthBypass, publicHost: "localhost", onAppError: () => {},
      browserLab: { enabled: true, isAllowedOrigin: () => true, onRegistered: (lab) => labs.push(lab) },
    }));
    expect((await app.request("/apps/browser-lab/api/status")).status).toBe(401);
    vi.stubEnv("MATRIX_AUTH_TOKEN", "synthetic-platform-asset-token");
    for (const path of ["/", "/api/status", "/api/viewer-session", "/viewer/"]) {
      expect((await app.request(`/apps/browser-lab${path}`, { headers: { authorization: "Bearer synthetic-platform-asset-token" } })).status).toBe(401);
    }
    const now = Math.floor(Date.now() / 1000);
    const token = signAppSession(deriveAppSessionKey(key, "browser-lab"), { v: 1, slug: "browser-lab", principal: "gateway-owner", scope: "personal", iat: now, exp: now + 600 });
    const response = await app.request("/apps/browser-lab/api/status", { headers: { cookie: `matrix_app_session__browser-lab=${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ phase: "idle" });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8730/status", expect.any(Object));
    labs[0].close();
    expect((await app.request("/apps/browser-lab/api/status", { headers: { cookie: `matrix_app_session__browser-lab=${token}` } })).status).toBe(404);
  });
});
