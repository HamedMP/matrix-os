import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token";
import { buildPlatformUserProof } from "../../packages/platform/src/session-routing-websocket";
import {
  isGatewayProxyPath,
  isPlatformMobileAppSessionRequest,
  isPublicShellPath,
  isSignUpShellPath,
  resolveCompletedSignupRedirect,
} from "../../shell/src/lib/proxy-routes";

/**
 * Unit tests for the proxy.ts auth logic.
 * These test the route classification and header injection behavior
 * without requiring a running Clerk or Next.js instance.
 */

describe("proxy auth: route classification", () => {
  it("classifies public paths correctly", () => {
    expect(isPublicShellPath("/health")).toBe(true);
    expect(isPublicShellPath("/manifest.json")).toBe(true);
    expect(isPublicShellPath("/og.png")).toBe(true);
    expect(isPublicShellPath("/favicon.ico")).toBe(true);
  });

  it("classifies Clerk auth pages as public shell paths", () => {
    expect(isPublicShellPath("/sign-in")).toBe(true);
    expect(isPublicShellPath("/sign-in/sso-callback")).toBe(true);
    expect(isPublicShellPath("/sign-up")).toBe(true);
    expect(isPublicShellPath("/sign-up/verify-email-address")).toBe(true);
  });

  it("identifies only sign-up pages as completed-signup recovery paths", () => {
    expect(isSignUpShellPath("/sign-up")).toBe(true);
    expect(isSignUpShellPath("/sign-up/verify-email-address")).toBe(true);
    expect(isSignUpShellPath("/sign-in")).toBe(false);
    expect(isSignUpShellPath("/sign-up-malicious")).toBe(false);
  });

  it("classifies only the exact runtime HTML route as public", () => {
    expect(isPublicShellPath("/runtime")).toBe(true);
    expect(isPublicShellPath("/runtime/other")).toBe(false);

    for (const protectedPath of [
      "/api/auth/computers",
      "/billing/status",
      "/billing/portal",
      "/files/runtime.json",
    ]) {
      expect(isPublicShellPath(protectedPath)).toBe(false);
    }
  });

  it("classifies only the exact computer onboarding HTML route as public", () => {
    expect(isPublicShellPath("/onboarding/computer")).toBe(true);
    expect(isPublicShellPath("/onboarding/computer/other")).toBe(false);
    expect(isPublicShellPath("/onboarding")).toBe(false);
  });

  it("classifies the billing setup shell entry as public without exposing the normal shell", () => {
    expect(isPublicShellPath("/", "?billing=setup")).toBe(true);
    expect(isPublicShellPath("/", "billing=setup")).toBe(true);
    expect(isPublicShellPath("/", "?billing=other")).toBe(false);
    expect(isPublicShellPath("/")).toBe(false);
  });

  it("keeps protected paths out of the public shell allowlist", () => {
    expect(isPublicShellPath("/")).toBe(false);
    expect(isPublicShellPath("/api/message")).toBe(false);
    expect(isPublicShellPath("/files/apps/todo")).toBe(false);
    expect(isPublicShellPath("/dashboard")).toBe(false);
  });

  it("identifies gateway proxy paths", () => {
    expect(isGatewayProxyPath("/api/message")).toBe(true);
    expect(isGatewayProxyPath("/api/identity")).toBe(true);
    expect(isGatewayProxyPath("/files/apps/todo/index.html")).toBe(true);
    expect(isGatewayProxyPath("/modules/weather")).toBe(true);
    expect(isGatewayProxyPath("/icons/notes.png")).toBe(true);
    expect(isGatewayProxyPath("/apps/calculator/")).toBe(true);
    expect(isGatewayProxyPath("/ws")).toBe(true);
    expect(isGatewayProxyPath("/ws/terminal")).toBe(true);
    expect(isGatewayProxyPath("/gateway/health")).toBe(true);
  });

  it("non-gateway paths are shell routes", () => {
    expect(isGatewayProxyPath("/")).toBe(false);
    expect(isGatewayProxyPath("/settings")).toBe(false);
    expect(isGatewayProxyPath("/health")).toBe(false);
    expect(isGatewayProxyPath("/ws-malicious")).toBe(false);
  });
});

describe("completed signup redirect validation", () => {
  const appOrigin = "https://app.matrix-os.com";

  it("accepts absolute and relative same-origin destinations", () => {
    expect(resolveCompletedSignupRedirect(
      "?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2F",
      appOrigin,
    )).toBe("/");
    expect(resolveCompletedSignupRedirect(
      "?redirect_url=%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
      appOrigin,
    )).toBe("/auth/device?user_code=BCDF-GHJK");
  });

  it("rejects external, protocol-relative, auth-loop, and oversized destinations", () => {
    expect(resolveCompletedSignupRedirect(
      "?redirect_url=https%3A%2F%2Fevil.example%2Fsteal",
      appOrigin,
    )).toBe("/");
    expect(resolveCompletedSignupRedirect(
      "?redirect_url=%2F%2Fevil.example%2Fsteal",
      appOrigin,
    )).toBe("/");
    expect(resolveCompletedSignupRedirect(
      "?redirect_url=%2Fsign-up%2Fverify-email-address",
      appOrigin,
    )).toBe("/");
    expect(resolveCompletedSignupRedirect(
      `?redirect_url=${encodeURIComponent(`/${"a".repeat(2_048)}`)}`,
      appOrigin,
    )).toBe("/");
    expect(resolveCompletedSignupRedirect(
      `?padding=${"a".repeat(8_192)}&redirect_url=%2Fauth%2Fdevice`,
      appOrigin,
    )).toBe("/");
  });
});

describe("proxy auth: completed signup recovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });

  async function loadProxy(
    userId: string | null,
    configuredAppUrl = "https://app.matrix-os.com",
    additionalEnv: Record<string, string> = {},
  ) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MATRIX_APP_URL", configuredAppUrl);
    for (const [key, value] of Object.entries(additionalEnv)) {
      vi.stubEnv(key, value);
    }
    const recoveryLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const recoveryError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const clerkRequestHandler = vi.fn(async (
      handler: (...args: unknown[]) => unknown,
      request: unknown,
      event: unknown,
    ) => handler(async () => ({ userId }), request, event));
    const clerkMiddleware = vi.fn((handler) => async (request: unknown, event: unknown) =>
      clerkRequestHandler(handler, request, event)
    );
    vi.doMock("@clerk/nextjs/server", () => ({ clerkMiddleware }));

    const nextResponseNext = vi.fn((init?: unknown) => ({ kind: "next", init }));
    const nextResponseRedirect = vi.fn((url: URL, status?: number) => ({
      kind: "redirect",
      url,
      status,
    }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = nextResponseRedirect;
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");
    return {
      proxy,
      clerkMiddleware,
      clerkRequestHandler,
      nextResponseNext,
      nextResponseRedirect,
      recoveryLog,
      recoveryError,
    };
  }

  function signupRequest(
    search: string,
    method = "GET",
    pathname = "/sign-up/verify-email-address",
  ) {
    return {
      method,
      headers: new Headers({
        host: "127.0.0.1:3200",
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "http",
      }),
      nextUrl: {
        host: "127.0.0.1:3200",
        pathname,
        protocol: "http:",
        search,
      },
    };
  }

  it("redirects a completed verification POST to the configured app origin with 303", async () => {
    const { proxy, nextResponseRedirect, recoveryLog } = await loadProxy("user_complete");

    const response = await proxy(
      signupRequest(
        "?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2F",
        "POST",
      ) as Parameters<typeof proxy>[0],
      {} as Parameters<typeof proxy>[1],
    );

    expect(response).toEqual({
      kind: "redirect",
      url: new URL("https://app.matrix-os.com/"),
      status: 303,
    });
    expect(nextResponseRedirect).toHaveBeenCalledOnce();
    expect(recoveryLog).toHaveBeenCalledWith("[auth] recovered completed signup");
  });

  it("preserves a validated same-origin device approval destination", async () => {
    const { proxy } = await loadProxy("user_complete");

    const response = await proxy(
      signupRequest(
        "?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
      ) as Parameters<typeof proxy>[0],
      {} as Parameters<typeof proxy>[1],
    );

    expect(response).toEqual({
      kind: "redirect",
      url: new URL("https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK"),
      status: 303,
    });
  });

  it("recovers an authenticated reload of the direct sign-up route", async () => {
    const { proxy } = await loadProxy("user_complete");

    const response = await proxy(
      signupRequest("", "GET", "/sign-up") as Parameters<typeof proxy>[0],
      {} as Parameters<typeof proxy>[1],
    );

    expect(response).toEqual({
      kind: "redirect",
      url: new URL("https://app.matrix-os.com/"),
      status: 303,
    });
  });

  it("falls back to the app root for an external destination", async () => {
    const { proxy } = await loadProxy("user_complete");

    const response = await proxy(
      signupRequest("?redirect_url=https%3A%2F%2Fevil.example%2Fsteal") as Parameters<typeof proxy>[0],
      {} as Parameters<typeof proxy>[1],
    );

    expect(response).toEqual({
      kind: "redirect",
      url: new URL("https://app.matrix-os.com/"),
      status: 303,
    });
  });

  it("recovers a provisioned user through the trusted platform fast path", async () => {
    const platformSecret = "platform-secret-123";
    const handle = "alice";
    const platformToken = buildPlatformVerificationToken(handle, platformSecret);
    const { proxy, clerkMiddleware, clerkRequestHandler } = await loadProxy(
      null,
      "https://app.matrix-os.com",
      {
        UPGRADE_TOKEN: platformToken,
        MATRIX_CLERK_USER_ID: "user_alice",
        MATRIX_HANDLE: handle,
        MATRIX_RUNTIME_SLOT: "primary",
      },
    );
    const request = signupRequest(
      "?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2Fauth%2Fdevice%3Fuser_code%3DBCDF-GHJK",
    );
    request.headers.set("authorization", `Bearer ${platformToken}`);
    request.headers.set("x-platform-user-id", "user_alice");
    request.headers.set(
      "x-platform-verified",
      buildPlatformUserProof(handle, "user_alice", platformSecret),
    );

    const response = await proxy(
      request as Parameters<typeof proxy>[0],
      {} as Parameters<typeof proxy>[1],
    );

    expect(response).toEqual({
      kind: "redirect",
      url: new URL("https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK"),
      status: 303,
    });
    expect(clerkMiddleware).toHaveBeenCalledOnce();
    expect(clerkRequestHandler).not.toHaveBeenCalled();
  });

  it("continues rendering the Clerk flow for an anonymous signup", async () => {
    const { proxy, nextResponseNext, nextResponseRedirect } = await loadProxy(null);

    const response = await proxy(
      signupRequest("?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2F") as Parameters<typeof proxy>[0],
      {} as Parameters<typeof proxy>[1],
    );

    expect(response).toEqual({ kind: "next", init: undefined });
    expect(nextResponseNext).toHaveBeenCalledOnce();
    expect(nextResponseRedirect).not.toHaveBeenCalled();
  });

  it("fails closed when the canonical app origin is not configured", async () => {
    const { proxy, nextResponseRedirect, recoveryError } = await loadProxy("user_complete", "");

    const response = await proxy(
      signupRequest("?redirect_url=https%3A%2F%2Fevil.example%2Fsteal") as Parameters<typeof proxy>[0],
      {} as Parameters<typeof proxy>[1],
    );

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(503);
    expect(nextResponseRedirect).not.toHaveBeenCalled();
    expect(recoveryError).toHaveBeenCalledWith(
      "[auth] completed signup recovery unavailable: app origin is not configured",
    );
  });
});

describe("proxy auth: screenshot bypass", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });



  it("still rewrites gateway paths and injects the gateway token in bypass mode", async () => {
    vi.resetModules();
    vi.stubEnv("E2E_TEST_BYPASS", "1");
    vi.stubEnv("MATRIX_AUTH_TOKEN", "local-gateway-token");
    vi.stubEnv("GATEWAY_URL", "http://localhost:4000");

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => handler),
    }));

    const nextResponseNext = vi.fn((init?: unknown) => ({ kind: "next", init }));
    const nextResponseRewrite = vi.fn((url: URL, init?: { request?: { headers?: Headers } }) => ({
      kind: "rewrite",
      url,
      init,
    }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = nextResponseRewrite;
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    proxy({
      headers: new Headers(),
      nextUrl: {
        host: "localhost:3001",
        pathname: "/api/shell/bootstrap",
        protocol: "http:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(nextResponseNext).not.toHaveBeenCalled();
    expect(nextResponseRewrite).toHaveBeenCalledTimes(1);
    const [url, init] = nextResponseRewrite.mock.calls[0] ?? [];
    expect(url?.toString()).toBe("http://localhost:4000/api/shell/bootstrap");
    expect(init?.request?.headers?.get("authorization")).toBe("Bearer local-gateway-token");
  });
});

describe("proxy auth: platform mobile app sessions", () => {
  it("allows mobile app launch requests with a bounded session query token", () => {
    expect(isPlatformMobileAppSessionRequest(
      "/apps/calculator/",
      "?session=mobile.session-token_1",
      null,
    )).toBe(true);
  });

  it("allows mobile app asset requests with the matching app session cookie", () => {
    expect(isPlatformMobileAppSessionRequest(
      "/apps/calculator/assets/index.js",
      "",
      "matrix_app_route=alice; matrix_app_session__calculator=session-cookie",
    )).toBe(true);
  });

  it("rejects app requests without a session token or matching session cookie", () => {
    expect(isPlatformMobileAppSessionRequest(
      "/apps/calculator/assets/index.js",
      "",
      "matrix_app_route=alice",
    )).toBe(false);
    expect(isPlatformMobileAppSessionRequest(
      "/apps/calculator/assets/index.js",
      "",
      "matrix_app_session__calculator=",
    )).toBe(false);
  });

  it("does not treat API paths or unsafe slugs as mobile app session requests", () => {
    expect(isPlatformMobileAppSessionRequest(
      "/api/apps/calculator/session-token",
      "?session=mobile.session-token_1",
      null,
    )).toBe(false);
    expect(isPlatformMobileAppSessionRequest(
      "/apps/-calculator/",
      "?session=mobile.session-token_1",
      null,
    )).toBe(false);
  });
});

describe("proxy auth: trusted platform native app sessions", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });

  it("converts the platform native marker into the shell's internal session marker", async () => {
    vi.resetModules();
    vi.stubEnv("UPGRADE_TOKEN", "platform-upgrade-token");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "user_alice");

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => async (request: unknown, event: unknown) =>
        handler(async () => ({ userId: null }), request, event)
      ),
    }));

    const nextResponseNext = vi.fn((init?: { request?: { headers?: Headers } }) => ({
      kind: "next",
      init,
    }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    proxy({
      headers: new Headers({
        authorization: "Bearer platform-upgrade-token",
        "x-platform-user-id": "user_alice",
        "x-matrix-native-app-session": "1",
      }),
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/",
        protocol: "https:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(nextResponseNext).toHaveBeenCalledTimes(1);
    const headers = nextResponseNext.mock.calls[0]?.[0]?.request?.headers;
    expect(headers?.get("x-matrix-platform-session")).toBe("native");
    expect(headers?.get("x-matrix-native-app-session")).toBeNull();
  });

  it("marks trusted platform page requests as server-verified sessions", async () => {
    vi.resetModules();
    vi.stubEnv("UPGRADE_TOKEN", "platform-upgrade-token");
    vi.stubEnv("MATRIX_CLERK_USER_ID", "user_alice");

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => async (request: unknown, event: unknown) =>
        handler(async () => ({ userId: null }), request, event)
      ),
    }));

    const nextResponseNext = vi.fn((init?: { request?: { headers?: Headers } }) => ({
      kind: "next",
      init,
    }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    proxy({
      headers: new Headers({
        authorization: "Bearer platform-upgrade-token",
        "x-platform-user-id": "user_alice",
      }),
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/",
        protocol: "https:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(nextResponseNext).toHaveBeenCalledTimes(1);
    const headers = nextResponseNext.mock.calls[0]?.[0]?.request?.headers;
    expect(headers?.get("x-matrix-platform-session")).toBe("platform");
    expect(headers?.get("x-matrix-native-app-session")).toBeNull();
  });

  it("accepts a platform-signed collaborator on preview shell and gateway routes", async () => {
    vi.resetModules();
    const platformSecret = "platform-secret-123";
    const handle = "pr-1055";
    const collaboratorId = "user_alice";
    const platformToken = buildPlatformVerificationToken(handle, platformSecret);
    vi.stubEnv("UPGRADE_TOKEN", platformToken);
    vi.stubEnv("MATRIX_CLERK_USER_ID", "user_bob");
    vi.stubEnv("MATRIX_HANDLE", handle);
    vi.stubEnv("MATRIX_RUNTIME_SLOT", handle);
    vi.stubEnv("MATRIX_AUTH_TOKEN", "preview-gateway-token");
    vi.stubEnv("GATEWAY_URL", "http://localhost:4000");

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => handler),
    }));

    const nextResponseNext = vi.fn((init?: { request?: { headers?: Headers } }) => ({
      kind: "next",
      init,
    }));
    const nextResponseRewrite = vi.fn((url: URL, init?: { request?: { headers?: Headers } }) => ({
      kind: "rewrite",
      url,
      init,
    }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = nextResponseRewrite;
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const platformHeaders = new Headers({
      authorization: `Bearer ${platformToken}`,
      "x-platform-user-id": collaboratorId,
      "x-platform-verified": buildPlatformUserProof(handle, collaboratorId, platformSecret),
    });
    const { proxy } = await import("../../shell/src/proxy");

    proxy({
      headers: platformHeaders,
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/",
        protocol: "https:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(nextResponseNext).toHaveBeenCalledOnce();
    expect(nextResponseNext.mock.calls[0]?.[0]?.request?.headers?.get("x-matrix-platform-session"))
      .toBe("platform");

    proxy({
      headers: platformHeaders,
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/api/projects",
        protocol: "https:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(nextResponseRewrite).toHaveBeenCalledOnce();
    expect(nextResponseRewrite.mock.calls[0]?.[1]?.request?.headers?.get("authorization"))
      .toBe("Bearer preview-gateway-token");
  });

  it("rejects a signed non-owner on a customer runtime", async () => {
    vi.resetModules();
    const platformSecret = "platform-secret-123";
    const handle = "bob";
    const collaboratorId = "user_alice";
    const platformToken = buildPlatformVerificationToken(handle, platformSecret);
    vi.stubEnv("UPGRADE_TOKEN", platformToken);
    vi.stubEnv("MATRIX_CLERK_USER_ID", "user_bob");
    vi.stubEnv("MATRIX_HANDLE", handle);
    vi.stubEnv("MATRIX_RUNTIME_SLOT", "primary");

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => handler),
    }));
    class MockNextResponse extends Response {
      static next = vi.fn((init?: unknown) => ({ kind: "next", init }));
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");
    const response = proxy({
      headers: new Headers({
        authorization: `Bearer ${platformToken}`,
        "x-platform-user-id": collaboratorId,
        "x-platform-verified": buildPlatformUserProof(handle, collaboratorId, platformSecret),
      }),
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/",
        protocol: "https:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(403);
  });

  it("rejects a collaborator with a forged platform user proof", async () => {
    vi.resetModules();
    const platformSecret = "platform-secret-123";
    const handle = "pr-1055";
    const platformToken = buildPlatformVerificationToken(handle, platformSecret);
    vi.stubEnv("UPGRADE_TOKEN", platformToken);
    vi.stubEnv("MATRIX_CLERK_USER_ID", "user_bob");
    vi.stubEnv("MATRIX_HANDLE", handle);
    vi.stubEnv("MATRIX_RUNTIME_SLOT", handle);

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => handler),
    }));
    class MockNextResponse extends Response {
      static next = vi.fn((init?: unknown) => ({ kind: "next", init }));
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");
    const response = proxy({
      headers: new Headers({
        authorization: `Bearer ${platformToken}`,
        "x-platform-user-id": "user_alice",
        "x-platform-verified": "0".repeat(64),
      }),
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/",
        protocol: "https:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(403);
  });

  it("rejects untrusted native session markers from browser requests", async () => {
    vi.resetModules();
    vi.stubEnv("UPGRADE_TOKEN", "platform-upgrade-token");

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => async (request: unknown, event: unknown) =>
        handler(async () => ({ userId: null }), request, event)
      ),
    }));

    class MockNextResponse extends Response {
      static next = vi.fn((init?: unknown) => ({ kind: "next", init }));
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    const response = proxy({
      headers: new Headers({
        "x-matrix-native-app-session": "1",
      }),
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/",
        protocol: "https:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(403);
  });
});

describe("proxy auth: self-host mode", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });

  it("serves shell pages without Clerk and still injects gateway auth for proxy paths", async () => {
    vi.resetModules();
    vi.stubEnv("MATRIX_SELF_HOSTED", "1");
    vi.stubEnv("MATRIX_AUTH_TOKEN", "self-host-gateway-token");
    vi.stubEnv("GATEWAY_URL", "http://127.0.0.1:4000");

    const clerkRequestHandler = vi.fn(async (request: unknown, event: unknown) => ({
      kind: "clerk",
      request,
      event,
    }));
    const clerkMiddleware = vi.fn(() => clerkRequestHandler);
    vi.doMock("@clerk/nextjs/server", () => ({ clerkMiddleware }));

    const nextResponseNext = vi.fn((init?: unknown) => ({ kind: "next", init }));
    const nextResponseRewrite = vi.fn((url: URL, init?: { request?: { headers?: Headers } }) => ({
      kind: "rewrite",
      url,
      init,
    }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = nextResponseRewrite;
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    const shellResponse = proxy({
      headers: new Headers(),
      nextUrl: {
        host: "matrix.example.com",
        pathname: "/",
        protocol: "http:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    proxy({
      headers: new Headers(),
      nextUrl: {
        host: "matrix.example.com",
        pathname: "/api/shell/bootstrap",
        protocol: "http:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(shellResponse).toEqual({ kind: "next", init: undefined });
    expect(clerkMiddleware).toHaveBeenCalledTimes(1);
    expect(clerkRequestHandler).not.toHaveBeenCalled();
    expect(nextResponseRewrite).toHaveBeenCalledTimes(1);
    const [url, init] = nextResponseRewrite.mock.calls[0] ?? [];
    expect(url?.toString()).toBe("http://127.0.0.1:4000/api/shell/bootstrap");
    expect(init?.request?.headers?.get("authorization")).toBe("Bearer self-host-gateway-token");
  });

  it("rejects reserved platform session markers in self-host mode", async () => {
    vi.resetModules();
    vi.stubEnv("MATRIX_SELF_HOSTED", "1");

    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn((handler) => handler),
    }));

    class MockNextResponse extends Response {
      static next = vi.fn((init?: unknown) => ({ kind: "next", init }));
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    const response = proxy({
      headers: new Headers({
        "x-matrix-platform-session": "platform",
      }),
      nextUrl: {
        host: "matrix.example.com",
        pathname: "/",
        protocol: "http:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(403);
  });

  it("skips ClerkProvider while disabling managed-cloud identity work in self-host mode", () => {
    const layout = readFileSync(join(process.cwd(), "shell/src/app/layout.tsx"), "utf8");
    const page = readFileSync(join(process.cwd(), "shell/src/app/page.tsx"), "utf8");

    expect(layout).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(layout).toContain('data-matrix-self-hosted={selfHostedMode ? "1" : undefined}');
    expect(layout).toContain("return renderDocument(false, (");
    expect(layout).toContain('<OrganizationStateProvider value={{ status: "none", organizationId: null }}>');
    expect(layout).toContain("{renderDocument(true, content)}");
    expect(layout).toContain("{includePostHogIdentify ? <PostHogIdentify /> : null}");
    expect(page).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(page).toContain("selfHostedMode || hasServerVerifiedMatrixSession");
  });
});

describe("proxy auth: billing setup entry", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });

  it("lets the anonymous billing setup URL render the shell gate instead of Clerk-redirecting", async () => {
    vi.resetModules();

    const clerkRequestHandler = vi.fn(async (request: unknown, event: unknown) => ({
      kind: "clerk",
      request,
      event,
    }));
    const clerkMiddleware = vi.fn(() => clerkRequestHandler);
    vi.doMock("@clerk/nextjs/server", () => ({ clerkMiddleware }));

    const nextResponseNext = vi.fn((init?: unknown) => ({ kind: "next", init }));
    const nextResponseRedirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = nextResponseRedirect;
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    const response = proxy({
      headers: new Headers({
        host: "app.matrix-os.com",
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "https",
      }),
      nextUrl: {
        host: "app.matrix-os.com",
        pathname: "/",
        protocol: "https:",
        search: "?billing=setup",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toEqual({ kind: "next", init: undefined });
    expect(clerkRequestHandler).not.toHaveBeenCalled();
    expect(nextResponseRedirect).not.toHaveBeenCalled();
  });
});

describe("proxy auth: runtime shell entry", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });

  it("bypasses Clerk for the production-shaped internal runtime proxy hop", async () => {
    vi.resetModules();

    const clerkRequestHandler = vi.fn(async (request: unknown, event: unknown) => ({
      kind: "clerk",
      request,
      event,
    }));
    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn(() => clerkRequestHandler),
    }));

    const nextResponseNext = vi.fn((init?: unknown) => ({ kind: "next", init }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");
    const response = proxy({
      headers: new Headers({
        host: "127.0.0.1:3200",
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "http",
      }),
      nextUrl: {
        host: "127.0.0.1:3200",
        pathname: "/runtime",
        protocol: "http:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toEqual({ kind: "next", init: undefined });
    expect(nextResponseNext).toHaveBeenCalledTimes(1);
    expect(clerkRequestHandler).not.toHaveBeenCalled();
  });

  it("bypasses Clerk for the production-shaped internal computer onboarding proxy hop", async () => {
    vi.resetModules();

    const clerkRequestHandler = vi.fn(async (request: unknown, event: unknown) => ({
      kind: "clerk",
      request,
      event,
    }));
    vi.doMock("@clerk/nextjs/server", () => ({
      clerkMiddleware: vi.fn(() => clerkRequestHandler),
    }));

    const nextResponseNext = vi.fn((init?: unknown) => ({ kind: "next", init }));
    class MockNextResponse extends Response {
      static next = nextResponseNext;
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");
    const response = proxy({
      headers: new Headers({
        host: "127.0.0.1:3200",
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "http",
      }),
      nextUrl: {
        host: "127.0.0.1:3200",
        pathname: "/onboarding/computer",
        protocol: "http:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toEqual({ kind: "next", init: undefined });
    expect(nextResponseNext).toHaveBeenCalledTimes(1);
    expect(clerkRequestHandler).not.toHaveBeenCalled();
  });
});

describe("proxy auth: sign-in redirects", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });

  it("uses the configured public HTTPS app origin for anonymous redirects", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_proxy_auth");
    vi.stubEnv("NEXT_PUBLIC_MATRIX_APP_URL", "https://app.matrix-os.com");

    const clerkMiddleware = vi.fn((handler) => async (request: unknown, event: unknown) =>
      handler(async () => ({ userId: null }), request, event)
    );
    vi.doMock("@clerk/nextjs/server", () => ({ clerkMiddleware }));

    const nextResponseRedirect = vi.fn((url: URL) => ({ kind: "redirect", url }));
    class MockNextResponse extends Response {
      static next = vi.fn((init?: unknown) => ({ kind: "next", init }));
      static rewrite = vi.fn((url: URL, init?: unknown) => ({ kind: "rewrite", url, init }));
      static redirect = nextResponseRedirect;
    }
    vi.doMock("next/server", () => ({ NextResponse: MockNextResponse }));

    const { proxy } = await import("../../shell/src/proxy");

    const response = await proxy({
      headers: new Headers({
        host: "127.0.0.1:3200",
        "x-forwarded-host": "app.matrix-os.com",
        "x-forwarded-proto": "http",
      }),
      nextUrl: {
        host: "127.0.0.1:3200",
        pathname: "/",
        protocol: "http:",
        search: "",
      },
    } as Parameters<typeof proxy>[0], {} as Parameters<typeof proxy>[1]);

    expect(response).toEqual({
      kind: "redirect",
      url: new URL(
        "https://app.matrix-os.com/sign-in?redirect_url=https%3A%2F%2Fapp.matrix-os.com%2F",
      ),
    });
    expect(nextResponseRedirect).toHaveBeenCalledTimes(1);
  });
});
