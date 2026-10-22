import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerBrowserSetupRoutes, createBrowserSetupClient } from "../../packages/gateway/src/browser-lab/setup.js";
const secret = "synthetic-browser-setup-owner-secret";
const jwtSecret = "synthetic-browser-setup-jwt-secret";
const failed = { status: "failed", retryAvailable: true };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function setup() {
  vi.stubEnv("MATRIX_USER_ID", "owner"); vi.stubEnv("MATRIX_CLERK_USER_ID", "owner");
  vi.stubEnv("MATRIX_HANDLE", "main-computer"); vi.stubEnv("MATRIX_RUNTIME_SLOT", "primary");
  vi.stubEnv("PLATFORM_JWT_SECRET", jwtSecret); vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", undefined);
  const client = { status: vi.fn(async () => failed), retry: vi.fn(async () => ({ status: "installing", retryAvailable: false })) };
  const app = new Hono(); app.use("*", authMiddleware(secret));
  registerBrowserSetupRoutes(app, { ownerId: "owner", client, isAllowedOrigin: origin => origin === "https://app.matrix-os.com" });
  const request = (method = "GET", token = secret, origin?: string, body?: string, suffix = "") => app.request(`https://app.matrix-os.com/api/browser/setup${suffix}`, { method,
    headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body } : {}) });
  const jwt = (sub: string, handle = "main-computer", slot = "primary") => new SignJWT({ handle, runtime_slot: slot, gateway_url: "https://app.matrix-os.com" }).setSubject(sub).setIssuer("matrix-os-platform").setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m").setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(jwtSecret));
  return { app, client, request, jwt };
}
describe("owner Browser setup before native enablement", () => {
  it("reads safe setup state and explicitly retries without an enabled broker or app manifest", async () => {
    const s = setup();
    const status = await s.request(); expect(status.status).toBe(200); expect(await status.json()).toEqual(failed);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const retry = await s.request("POST", secret, "https://app.matrix-os.com", "{}", "/retry");
    expect(retry.status).toBe(202); expect(await retry.json()).toEqual({ status: "installing", retryAvailable: false });
    expect(s.client.retry).toHaveBeenCalledTimes(1);
  });
  it("retains owner, handle, runtime-slot and CSRF boundary", async () => {
    const s = setup();
    expect((await s.request("GET", "invalid")).status).toBe(401);
    expect((await s.request("GET", await s.jwt("collaborator"))).status).toBe(403);
    expect((await s.request("GET", await s.jwt("owner", "other-runtime"))).status).toBe(401);
    expect((await s.request("GET", await s.jwt("owner", "main-computer", "preview"))).status).toBe(401);
    expect((await s.request("POST", secret, "https://evil.test", "{}", "/retry")).status).toBe(403);
    expect((await s.request("POST", secret, undefined, "{}", "/retry")).status).toBe(403);
    expect(s.client.retry).not.toHaveBeenCalled();
  });
  it("rejects action fields, invalid JSON, streaming oversized input and unsupported methods before retry", async () => {
    const s = setup();
    for (const body of ['{"command":"arbitrary"}', "[]", "{"]) expect((await s.request("POST", secret, "https://app.matrix-os.com", body, "/retry")).status).toBe(400);
    const oversized = await s.app.request("https://app.matrix-os.com/api/browser/setup/retry", { method: "POST", headers: { authorization: `Bearer ${secret}`, origin: "https://app.matrix-os.com" },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(4097))); controller.close(); } }), duplex: "half" } as RequestInit);
    expect(oversized.status).toBe(413); expect((await s.request("DELETE")).status).toBe(405); expect(s.client.retry).not.toHaveBeenCalled();
  });
  it("does not reflect native failures or unvalidated status into the response", async () => {
    const s = setup(); s.client.status.mockRejectedValueOnce(new Error("/private/path secret-token"));
    const response = await s.request(); expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/private|secret-token/);
    s.client.status.mockResolvedValueOnce({ ...failed, detail: "private" });
    expect((await s.request()).status).toBe(503);
  });
  it("uses only bounded fixed privileged helper arguments", async () => {
    const execute = vi.fn(async () => ({ stdout: JSON.stringify(failed), stderr: "" }));
    const client = createBrowserSetupClient(execute); expect(await client.status()).toEqual(failed); await client.retry();
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      ["-n", "/usr/bin/python3", "-I", "/usr/local/libexec/matrix-browser-runtime.py", "--status"],
      ["-n", "/usr/bin/python3", "-I", "/usr/local/libexec/matrix-browser-runtime.py", "--retry"],
    ]);
    expect(execute).toHaveBeenCalledWith("/usr/bin/sudo", expect.any(Array), expect.objectContaining({ timeout: 5000, maxBuffer: 4096, env: expect.objectContaining({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }) }));
  });
});

describe("setup composition identity", () => {
  it("admits only valid owner-bound primary hosts before enablement", async () => {
    const { resolveBrowserSetupOwner } = await import("../../packages/gateway/src/browser-lab/setup.js");
    const env = { MATRIX_RUNTIME_SLOT: "primary", MATRIX_HANDLE: "main-computer", MATRIX_MACHINE_ID: "9f05824c-8d0a-4d83-9cb4-b312d43ff112", MATRIX_CLERK_USER_ID: "user_owner", MATRIX_USER_ID: "user_owner" };
    expect(resolveBrowserSetupOwner(env)).toBe("user_owner");
    expect(resolveBrowserSetupOwner({ ...env, MATRIX_USER_ID: undefined })).toBe("user_owner");
    for (const overrides of [{ MATRIX_RUNTIME_SLOT: "preview" }, { MATRIX_HANDLE: "pv-2526-test" }, { MATRIX_MACHINE_ID: undefined }, { MATRIX_USER_ID: "other" }, { MATRIX_CLERK_USER_ID: undefined }]) expect(resolveBrowserSetupOwner({ ...env, ...overrides })).toBeUndefined();
  });
});
