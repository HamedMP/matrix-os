import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token";
import { buildPlatformUserProof } from "../../packages/platform/src/session-routing-websocket";
import {
  isPlatformMobileAppSessionRequest,
  isPublicShellPath,
} from "../../shell/src/lib/proxy-routes";

/**
 * Unit tests for the proxy.ts auth logic.
 * These test the route classification and header injection behavior
 * without requiring a running Clerk or Next.js instance.
 */

const PUBLIC_PATHS = ["/health", "/manifest.json", "/og.png", "/favicon.ico"];
const GATEWAY_PREFIXES = ["/gateway/", "/api/", "/files/", "/modules/", "/ws"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname);
}

function isGatewayProxy(pathname: string): boolean {
  return GATEWAY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function shouldBypassAuth(env: {
  E2E_TEST_BYPASS?: string;
  NODE_ENV?: string;
}): boolean {
  return env.E2E_TEST_BYPASS === "1";
}

function resolveGatewayTarget(pathname: string): string {
  return pathname.startsWith("/gateway/")
    ? pathname.replace("/gateway", "")
    : pathname;
}

function shouldInjectAuthToken(
  pathname: string,
  authToken: string | undefined,
): boolean {
  return isGatewayProxy(pathname) && !!authToken;
}

function isOwnerMatch(
  userId: string | null,
  expectedClerkUserId: string | undefined,
): boolean {
  if (!expectedClerkUserId) return true;
  if (!userId) return true; // no user yet (pre-auth)
  return userId === expectedClerkUserId;
}

describe("proxy auth: route classification", () => {
  it("classifies public paths correctly", () => {
    expect(isPublicPath("/health")).toBe(true);
    expect(isPublicPath("/manifest.json")).toBe(true);
    expect(isPublicPath("/og.png")).toBe(true);
    expect(isPublicPath("/favicon.ico")).toBe(true);
  });

  it("classifies Clerk auth pages as public shell paths", () => {
    expect(isPublicShellPath("/sign-in")).toBe(true);
    expect(isPublicShellPath("/sign-in/sso-callback")).toBe(true);
    expect(isPublicShellPath("/sign-up")).toBe(true);
    expect(isPublicShellPath("/sign-up/verify-email-address")).toBe(true);
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

  it("non-public paths require auth", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/message")).toBe(false);
    expect(isPublicPath("/files/apps/todo")).toBe(false);
    expect(isPublicPath("/dashboard")).toBe(false);
  });

  it("identifies gateway proxy paths", () => {
    expect(isGatewayProxy("/api/message")).toBe(true);
    expect(isGatewayProxy("/api/identity")).toBe(true);
    expect(isGatewayProxy("/files/apps/todo/index.html")).toBe(true);
    expect(isGatewayProxy("/modules/weather")).toBe(true);
    expect(isGatewayProxy("/ws")).toBe(true);
    expect(isGatewayProxy("/ws/terminal")).toBe(true);
    expect(isGatewayProxy("/gateway/health")).toBe(true);
  });

  it("non-gateway paths are shell routes", () => {
    expect(isGatewayProxy("/")).toBe(false);
    expect(isGatewayProxy("/settings")).toBe(false);
    expect(isGatewayProxy("/health")).toBe(false);
  });
});

describe("proxy auth: screenshot bypass", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.doUnmock("@clerk/nextjs/server");
    vi.doUnmock("next/server");
  });

  it("bypasses auth when the explicit E2E flag is set", () => {
    expect(shouldBypassAuth({ E2E_TEST_BYPASS: "1", NODE_ENV: "production" })).toBe(true);
    expect(shouldBypassAuth({ E2E_TEST_BYPASS: "1", NODE_ENV: "test" })).toBe(true);
  });

  it("does not bypass auth without the explicit E2E flag", () => {
    expect(shouldBypassAuth({ NODE_ENV: "test" })).toBe(false);
    expect(shouldBypassAuth({ E2E_TEST_BYPASS: "0", NODE_ENV: "production" })).toBe(false);
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

describe("proxy auth: gateway target resolution", () => {
  it("strips /gateway prefix", () => {
    expect(resolveGatewayTarget("/gateway/health")).toBe("/health");
    expect(resolveGatewayTarget("/gateway/api/message")).toBe("/api/message");
  });

  it("preserves other paths as-is", () => {
    expect(resolveGatewayTarget("/api/message")).toBe("/api/message");
    expect(resolveGatewayTarget("/files/apps/todo")).toBe("/files/apps/todo");
    expect(resolveGatewayTarget("/ws")).toBe("/ws");
  });
});

describe("proxy auth: Layer 2 owner verification", () => {
  it("allows when no expected user ID is configured", () => {
    expect(isOwnerMatch("user_abc", undefined)).toBe(true);
    expect(isOwnerMatch(null, undefined)).toBe(true);
  });

  it("allows matching user", () => {
    expect(isOwnerMatch("user_abc", "user_abc")).toBe(true);
  });

  it("rejects mismatched user", () => {
    expect(isOwnerMatch("user_xyz", "user_abc")).toBe(false);
  });

  it("allows null user (pre-auth state)", () => {
    expect(isOwnerMatch(null, "user_abc")).toBe(true);
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
    expect(layout).toContain("return renderDocument(false);");
    expect(layout).toContain("{renderDocument(true)}");
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

describe("proxy auth: Layer 3 bearer token injection", () => {
  it("injects token on gateway proxy paths when token is set", () => {
    expect(shouldInjectAuthToken("/api/message", "secret-token")).toBe(true);
    expect(shouldInjectAuthToken("/files/apps/todo", "secret-token")).toBe(true);
    expect(shouldInjectAuthToken("/ws", "secret-token")).toBe(true);
  });

  it("does not inject token when no token configured", () => {
    expect(shouldInjectAuthToken("/api/message", undefined)).toBe(false);
    expect(shouldInjectAuthToken("/api/message", "")).toBe(false);
  });

  it("does not inject token on non-gateway paths", () => {
    expect(shouldInjectAuthToken("/", "secret-token")).toBe(false);
    expect(shouldInjectAuthToken("/settings", "secret-token")).toBe(false);
    expect(shouldInjectAuthToken("/health", "secret-token")).toBe(false);
  });
});
