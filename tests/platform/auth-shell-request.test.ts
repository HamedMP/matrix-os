import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../packages/platform/src/main.js";
import type { PlatformDB } from "../../packages/platform/src/db.js";
import { createClerkAuth } from "../../packages/platform/src/clerk-auth.js";
import { shouldProxyAuthShellForUnroutedUser } from "../../packages/platform/src/request-routing.js";
import { stubOrchestrator } from "./proxy-routing-test-utils.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function app() {
  vi.stubEnv("MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED", "false");
  vi.stubEnv("AUTH_SHELL_HOST", "auth-shell.test");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_fixture");
  return createApp({
    // Public sign-in does not read the platform database.
    db: {} as PlatformDB, orchestrator: stubOrchestrator(),
    clerkAuth: createClerkAuth({ verifyToken: async () => { throw new Error("Unexpected token verification"); } }),
    platformSecret: "fixture-platform-secret",
  });
}

describe("platform forwarding to the local auth shell", () => {
  it.each(["/api/projects", "/files/example.txt", "/sign-in-untrusted"])("does not route unrelated POST %s to the auth shell", (path) => {
    expect(shouldProxyAuthShellForUnroutedUser({ isAppDomain: true, method: "POST", path })).toBe(false);
  });

  it.each(["/sign-in", "/sign-up/verify-email-address"])("forwards a Next Server Action body from %s intact", async (path) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("action-result"));
    const response = await app().request("https://app.matrix-os.com" + path, {
      method: "POST", headers: { host: "app.matrix-os.com", "next-action": "fixture-action", "content-type": "text/plain" },
      body: '["invalidate-clerk-cache"]',
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://auth-shell.test:3200" + path);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("next-action")).toBe("fixture-action");
    expect(new Headers(init?.headers).get("x-forwarded-proto")).toBe("http");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(await new Response(init?.body).text()).toBe('["invalidate-clerk-cache"]');
  });

  it("forwards the configured browser host for Next's Server Action origin check", async () => {
    vi.stubEnv("MATRIX_APP_ORIGIN", "https://preview.example.test");
    vi.stubEnv("MATRIX_APP_DOMAIN_HOSTS", "service.run.app,preview.example.test");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("action-result"));
    const response = await app().request("https://service.run.app/sign-in", {
      method: "POST", headers: { host: "service.run.app", origin: "https://preview.example.test", "next-action": "fixture-action" },
      body: "[]",
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("x-forwarded-host")).toBe(new URL(headers.get("origin")!).host);
    expect(headers.get("host")).toBe("auth-shell.test:3200");
    expect(headers.get("x-forwarded-proto")).toBe("http");
  });

  it("does not attach a body to GET", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("sign-in"));
    expect((await app().request("https://app.matrix-os.com/sign-in", { headers: { host: "app.matrix-os.com" } })).status).toBe(200);
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
  });

  it("rejects oversized Server Action bodies before forwarding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unexpected"));
    const response = await app().request("https://app.matrix-os.com/sign-in", {
      method: "POST", headers: { host: "app.matrix-os.com", "content-type": "text/plain" },
      body: "x".repeat(10 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
