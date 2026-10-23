import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createGatewayAllowedOriginController } from "../../packages/gateway/src/server/browser-setup-origin.js";
import { registerDeferredRuntimeRoutes } from "../../packages/gateway/src/server/deferred-runtime-routes.js";
import * as setupModule from "../../packages/gateway/src/browser-lab/setup.js";
const secret = "synthetic-setup-composition-owner-token";
const jwtSecret = "synthetic-setup-composition-jwt-secret";
const owner = "user_fixture";
const primary = {
  MATRIX_CLERK_USER_ID: owner, MATRIX_USER_ID: owner, MATRIX_RUNTIME_SLOT: "primary", MATRIX_HANDLE: "fixture-computer",
  MATRIX_MACHINE_ID: "9f05824c-8d0a-4d83-9cb4-b312d43ff112",
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("fresh primary Browser retry origin composition", () => {
  it.each(["https://app.matrix-os.com", "https://custom-app.example"])("preserves owner retry from %s before and after real native enablement", async appOrigin => {
    for (const [key, value] of Object.entries(primary)) vi.stubEnv(key, value);
    for (const key of ["SHELL_ORIGIN", "PROXY_ORIGIN", "MATRIX_PUBLIC_APP_URL", "MATRIX_BROWSER_LAB", "PLATFORM_JWT_PUBLIC_KEY", "UPGRADE_TOKEN", "MATRIX_PLATFORM_URL"]) vi.stubEnv(key, undefined);
    vi.stubEnv("MATRIX_PUBLIC_APP_URL", appOrigin);
    vi.stubEnv("MATRIX_AUTH_TOKEN", secret); vi.stubEnv("PLATFORM_JWT_SECRET", jwtSecret); vi.stubEnv("NODE_ENV", "production");
    const client = { status: vi.fn(async () => ({ status: "failed", retryAvailable: true })), retry: vi.fn(async () => ({ status: "installing", retryAvailable: false })) };
    vi.spyOn(setupModule, "createBrowserSetupClient").mockReturnValue(client);
    const homePath = await mkdtemp(join(tmpdir(), "browser-setup-origin-")); cleanups.push(() => rm(homePath, { recursive: true, force: true }));
    // Real bootstrap controller and deferred route composition, not a stubbed origin predicate.
    let controller = createGatewayAllowedOriginController(process.env);
    const app = new Hono(); app.use("*", authMiddleware(secret));
    const runtime = await registerDeferredRuntimeRoutes({ app, homePath, ownerDatabase: null, isAllowedBrowserLabOrigin: origin => controller.resolve(origin) === origin,
      integrationRoutes: null, internalIntegrationBaseUrl: null, internalPlatformToken: undefined, internalPlatformUrl: undefined, internalHandle: primary.MATRIX_HANDLE,
      proxyIntegrationRequest: async () => new Response(null, { status: 503 }), devAppAuthBypass: false,
      posthogErrorTracker: { captureEvent: vi.fn() } as never, ownerTelemetryDistinctId: "fixture-owner",
    });
    cleanups.push(async () => { runtime.browserLab.close(); runtime.customMcp.stop(); await runtime.processManager.shutdownAll(); });
    const jwt = async (sub: string) => new SignJWT({ handle: primary.MATRIX_HANDLE, runtime_slot: "primary", gateway_url: appOrigin })
      .setSubject(sub).setIssuer("matrix-os-platform").setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m").setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(jwtSecret));
    const request = (token: string, origin?: string) => app.request(`${appOrigin}/api/browser/setup/retry`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}",
    });
    expect(process.env.SHELL_ORIGIN).toBeUndefined(); expect(process.env.MATRIX_BROWSER_LAB).toBeUndefined();
    const accepted = await request(await jwt(owner), appOrigin);
    expect(accepted.status).toBe(202); expect(await accepted.json()).toEqual({ status: "installing", retryAvailable: false });
    expect((await request(await jwt(owner), "https://evil.test")).status).toBe(403);
    expect((await request(await jwt(owner))).status).toBe(403);
    expect((await request(await jwt("user_collaborator"), "https://app.matrix-os.com")).status).toBe(403);
    expect(client.retry).toHaveBeenCalledTimes(1);
    // Execute the real helper against a contained host fixture, then rebuild
    // the gateway controller from the environment it actually persisted.
    const hostRoot = join(homePath, 'host-fixture');
    const envPath = join(hostRoot, 'opt/matrix/env/host.env');
    await mkdir(join(hostRoot, 'opt/matrix/env'), { recursive: true });
    await mkdir(join(hostRoot, 'opt/matrix/bin'), { recursive: true });
    const hostValues = { ...primary, MATRIX_PUBLIC_APP_URL: appOrigin, MATRIX_BROWSER_LAB_VIEWER_AUTH: '"Basic eDp5"' };
    await writeFile(envPath, Object.entries(hostValues).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o640 });
    execFileSync('python3', ['-I', '-B', '-c', `
import importlib.util, os, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('browser_runtime', 'distro/customer-vps/host-bin/matrix-browser-runtime.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runtime = module.Runtime(Path(sys.argv[1]), os.getuid(), os.getgid())
runtime.prepare()
runtime.enable_environment()
`, hostRoot], { timeout: 5000, maxBuffer: 4096 });
    const persisted = Object.fromEntries((await readFile(envPath, 'utf8')).trim().split('\n').map(line => {
      const separator = line.indexOf('='); return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    controller = createGatewayAllowedOriginController(persisted);
    expect((await request(await jwt(owner), appOrigin)).status).toBe(202);
    expect(persisted.SHELL_ORIGIN).toBeUndefined();
    expect((await request(await jwt(owner), 'https://evil.test')).status).toBe(403);
    expect(client.retry).toHaveBeenCalledTimes(2);
  });
  it("keeps explicit operator configuration and invalid host identity fail closed", () => {
    expect(createGatewayAllowedOriginController({ ...primary, SHELL_ORIGIN: "https://shell.example" }).resolve("https://app.matrix-os.com")).toBeUndefined();
    for (const invalid of [{ MATRIX_RUNTIME_SLOT: "preview" }, { MATRIX_USER_ID: "user_other" }, { MATRIX_MACHINE_ID: undefined }, { MATRIX_HANDLE: "pv-fixture" }]) {
      expect(createGatewayAllowedOriginController({ ...primary, ...invalid }).resolve("https://app.matrix-os.com")).toBeUndefined();
    }
    expect(createGatewayAllowedOriginController({}).resolve("https://app.matrix-os.com")).toBeUndefined();
    expect(createGatewayAllowedOriginController({ ...primary, MATRIX_PUBLIC_APP_URL: "https://private-app.example" }).resolve("https://private-app.example")).toBe("https://private-app.example");
    for (const value of ["http://app.example", "https://user:password@app.example", "https://app.example/path", "https://app.example?query=1", "https://app.example#hash", "invalid"]) {
      expect(createGatewayAllowedOriginController({ ...primary, MATRIX_PUBLIC_APP_URL: value }).resolve("https://app.matrix-os.com")).toBeUndefined();
      expect(createGatewayAllowedOriginController({ ...primary, MATRIX_PUBLIC_APP_URL: value }).resolve(value)).toBeUndefined();
    }
  });
});
