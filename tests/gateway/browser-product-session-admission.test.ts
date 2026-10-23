import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerAppRuntimeRoutes } from "../../packages/gateway/src/server/app-runtime-routes.js";
import { createSharedBrowserBroker } from "../../packages/gateway/src/shared-browser/broker.js";

const secret = "synthetic-browser-product-owner-secret";
const jwtSecret = "synthetic-browser-product-jwt-secret-32";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function setup({ enabled = true, shared = true, authenticated = true, productUiPath, setupOwnerId }: {
  enabled?: boolean; shared?: boolean; authenticated?: boolean; productUiPath?: string; setupOwnerId?: string;
} = {}) {
  const homePath = await mkdtemp(join(tmpdir(), "browser-product-admission-"));
  cleanups.push(() => rm(homePath, { recursive: true, force: true }));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", undefined);
  vi.stubEnv("MATRIX_AUTH_TOKEN", secret);
  vi.stubEnv("MATRIX_USER_ID", "owner");
  vi.stubEnv("MATRIX_CLERK_USER_ID", "owner");
  vi.stubEnv("MATRIX_HANDLE", "main-computer");
  vi.stubEnv("MATRIX_RUNTIME_SLOT", "primary");
  vi.stubEnv("PLATFORM_JWT_SECRET", jwtSecret);
  const broker = createSharedBrowserBroker({ ownerId: "owner", driver: {
    execute: vi.fn(), invalidateObservation: vi.fn(), detach: vi.fn(async () => {}),
  }, setHumanControl: vi.fn(async () => {}) });
  cleanups.push(() => broker.close());
  const app = new Hono();
  if (authenticated) app.use("*", authMiddleware(secret));
  const manager = registerAppRuntimeRoutes(app, {
    homePath, appSessionMasterSecret: secret, devAppAuthBypass: false,
    publicHost: "app.matrix-os.com", onAppError: () => {},
    browserLab: { enabled, productUiPath, setupOwnerId, isAllowedOrigin: origin => origin === "https://app.matrix-os.com",
      ...(shared ? { sharedBrowser: { broker, ownerId: "owner" } } : {}),
      onRegistered: lab => cleanups.push(async () => lab.close()),
    },
  });
  cleanups.push(() => manager.shutdownAll());
  const request = (suffix: string, token = secret, body = "{}") => app.request(
    `https://app.matrix-os.com/api/apps/browser-lab/${suffix}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
    });
  const jwt = (sub: string, handle = "main-computer", slot = "primary") => new SignJWT({
    handle, runtime_slot: slot, gateway_url: "https://app.matrix-os.com",
  }).setSubject(sub).setIssuer("matrix-os-platform").setAudience("matrix-os-sync")
    .setIssuedAt().setExpirationTime("5m").setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(jwtSecret));
  return { app, homePath, request, jwt };
}

describe("OS-owned Browser session admission", () => {
  it("admits owner cookie and one-use native launches without an owner app manifest", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      available: true, chrome: { present: true, minimized: false }, humanControlAvailable: true,
    }));
    const s = await setup();
    const direct = await s.request("session");
    expect(direct.status).toBe(200);
    expect(direct.headers.get("set-cookie")).toContain("Path=/apps/browser-lab/; HttpOnly; SameSite=Strict; Secure");
    const webStatus = await s.app.request("/apps/browser-lab/api/browser-status", {
      headers: { cookie: direct.headers.get("set-cookie")!.split(";")[0] },
    });
    expect(webStatus.status).toBe(200);
    expect(await webStatus.json()).toMatchObject({ available: true });
    const launch = await s.request("session-token");
    expect(launch.status).toBe(200);
    const { launchUrl, token } = await launch.json();
    expect(token).toMatch(/^main-computer\./);
    const exchanged = await s.app.request(`https://app.matrix-os.com${launchUrl}`);
    expect(exchanged.status).toBe(302);
    expect(exchanged.headers.get("location")).toBe("/apps/browser-lab/");
    expect((await s.app.request(launchUrl)).status).toBe(401);
    const cookie = exchanged.headers.get("set-cookie")!.split(";")[0];
    const status = await s.app.request("/apps/browser-lab/api/browser-status", { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ available: true });
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8730/browser-status", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
    expect(await readdir(s.homePath)).toEqual([]);
  });

  it("serves the authenticated OS entry/assets without owner-app shadow or traversal", async () => {
    const productUiPath = await mkdtemp(join(tmpdir(), "browser-product-ui-"));
    cleanups.push(() => rm(productUiPath, { recursive: true, force: true }));
    await mkdir(join(productUiPath, "assets"));
    await writeFile(join(productUiPath, "index.html"), '<!doctype html><title>OS Browser</title>');
    await writeFile(join(productUiPath, "assets", "browser.js"), 'document.title="OS Browser";');
    const s = await setup({ productUiPath });
    await mkdir(join(s.homePath, "apps", "browser-lab"), { recursive: true });
    await writeFile(join(s.homePath, "apps", "browser-lab", "private.txt"), "owner data");
    await symlink(join(s.homePath, "apps", "browser-lab", "private.txt"), join(productUiPath, "assets", "escaped.js"));
    const launched = await s.request("session-token");
    const { launchUrl } = await launched.json();
    const exchange = await s.app.request(`${launchUrl}&surface=browser`);
    expect(exchange.headers.get("location")).toBe("/apps/browser-lab/?surface=browser");
    const headers = { cookie: exchange.headers.get("set-cookie")!.split(";")[0] };
    const html = await s.app.request("/apps/browser-lab/?surface=browser", { headers });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("OS Browser");
    expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");
    const asset = await s.app.request("/apps/browser-lab/assets/browser.js", { headers });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('document.title="OS Browser";');
    const head = await s.app.request("/apps/browser-lab/assets/browser.js", { method: "HEAD", headers });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const platformAsset = await s.app.request("/apps/browser-lab/assets/browser.js", { headers: { authorization: `Bearer ${secret}` } });
    expect(platformAsset.status).toBe(200);
    expect(await platformAsset.text()).toContain("OS Browser");
    expect((await s.app.request("/apps/browser-lab/", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(401);
    expect((await s.app.request("/apps/browser-lab/assets/browser.js")).status).toBe(401);
    expect((await s.app.request("/apps/browser-lab/assets/escaped.js", { headers })).status).toBe(403);
    expect((await s.app.request("/apps/browser-lab/private.txt", { headers })).status).toBe(404);
    expect((await s.app.request("/apps/browser-lab/assets/missing.js", { headers })).status).toBe(404);
    expect((await s.app.request("/apps/browser-lab/assets/%2e%2e%2fprivate.txt", { headers })).status).toBe(400);
    expect((await s.app.request("/apps/browser-lab/", { method: "POST", headers, body: "{}" })).status).toBe(405);
  });

  it("preserves an existing owner app and never uses its manifest as OS authority", async () => {
    const s = await setup();
    const dir = join(s.homePath, "apps", "browser-lab");
    await mkdir(dir, { recursive: true });
    const contents = JSON.stringify({ name: "Owner app", slug: "browser-lab", scope: "shared",
      runtime: "static", version: "1.0.0", runtimeVersion: "^1.0.0", listingTrust: "first_party" });
    await writeFile(join(dir, "matrix.json"), contents);
    for (const suffix of ["session", "session-token"]) expect((await s.request(suffix)).status).toBe(200);
    expect(await readFile(join(dir, "matrix.json"), "utf8")).toBe(contents);
    expect((await s.app.request("/api/apps/other-app/session", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "{}" })).status).toBe(404);
  });

  it("retains ordinary application scope policy outside the exact OS Browser slug", async () => {
    const s = await setup();
    for (const [slug, scope, status] of [["owner-app", "personal", 200], ["shared-app", "shared", 409]] as const) {
      const dir = join(s.homePath, "apps", slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "matrix.json"), JSON.stringify({ name: slug, slug, scope,
        runtime: "static", version: "1.0.0", runtimeVersion: "^1.0.0", listingTrust: "first_party" }));
      for (const suffix of ["session", "session-token"]) {
        const response = await s.app.request(`/api/apps/${slug}/${suffix}`, {
          method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "{}",
        });
        expect(response.status).toBe(status);
      }
    }
  });

  it("uses the trusted composed owner on Clerk-only hosts without enabling unauthenticated fallback", async () => {
    const s = await setup();
    vi.stubEnv("MATRIX_USER_ID", undefined);
    for (const suffix of ["session", "session-token"]) {
      expect((await s.request(suffix)).status).toBe(200);
      expect((await s.request(suffix, await s.jwt("collaborator"))).status).toBe(403);
    }
  });

  it("requires verified owner authentication and retains handle/slot JWT binding", async () => {
    const s = await setup();
    for (const suffix of ["session", "session-token"]) {
      expect((await s.request(suffix, await s.jwt("owner"))).status).toBe(200);
      expect((await s.request(suffix, await s.jwt("collaborator"))).status).toBe(403);
      expect((await s.request(suffix, await s.jwt("owner", "other-runtime"))).status).toBe(401);
      expect((await s.request(suffix, await s.jwt("owner", "main-computer", "preview"))).status).toBe(401);
      expect((await s.request(suffix, "invalid")).status).toBe(401);
      expect((await s.request(suffix, secret, "x".repeat(4097))).status).toBe(413);
    }
    const unauthenticated = await setup({ authenticated: false });
    for (const suffix of ["session", "session-token"]) expect((await unauthenticated.request(suffix)).status).toBe(401);
  });

  it.each([{ enabled: false }, { shared: false }])("keeps manifest admission when OS Browser composition is unavailable: %j", async options => {
    const s = await setup(options);
    for (const suffix of ["session", "session-token"]) expect((await s.request(suffix)).status).toBe(404);
  });
});


describe("OS setup admission before native enablement", () => {
  it("serves only OS UI behind owner session and keeps native control unavailable", async () => {
    const productUiPath = await mkdtemp(join(tmpdir(), "browser-setup-ui-"));
    cleanups.push(() => rm(productUiPath, { recursive: true, force: true }));
    await writeFile(join(productUiPath, "matrix-browser-ui-index.html"), '<!doctype html><title>Browser setup</title><script src="./assets/setup.js"></script>');
    await writeFile(join(productUiPath, "matrix-browser-ui-setup.js"), "OS setup asset");
    await writeFile(join(productUiPath, "matrix-browser-runtime.py"), "never exposed");
    const s = await setup({ enabled: false, shared: false, setupOwnerId: "owner", productUiPath });
    const admitted = await s.request("session"); expect(admitted.status).toBe(200);
    const headers = { cookie: admitted.headers.get("set-cookie")!.split(";")[0] };
    const html = await s.app.request("/apps/browser-lab/", { headers });
    expect(html.status).toBe(200); expect(await html.text()).toContain("Browser setup");
    const asset = await s.app.request("/apps/browser-lab/assets/setup.js", { headers });
    expect(asset.status).toBe(200); expect(await asset.text()).toBe("OS setup asset");
    expect(asset.headers.get("content-type")).toBe("application/javascript");
    expect((await s.app.request("/apps/browser-lab/assets/matrix-browser-runtime.py", { headers })).status).toBe(404);
    expect((await s.app.request("/apps/browser-lab/matrix-browser-runtime.py", { headers })).status).toBe(404);
    expect((await s.app.request("/apps/browser-lab/api/browser-status", { headers })).status).toBe(404);
    expect((await s.app.request("/apps/browser-lab/api/browser-control", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await s.request("session", await s.jwt("collaborator"))).status).toBe(403);
    expect((await s.app.request("/apps/browser-lab/")).status).toBe(401);
  });
});
