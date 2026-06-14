import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { config, proxyWithSecurity } from "../../www/src/proxy";

type ProxyModule = typeof import("../../www/src/proxy");

function makeRequest(pathname: string) {
  return {
    headers: new Headers(),
    nextUrl: new URL(`https://matrix-os.com${pathname}`),
  } as Parameters<ProxyModule["default"]>[0];
}

function expectSecurityHeaders(response: Response) {
  const csp = response.headers.get("Content-Security-Policy");
  expect(csp).toBeTruthy();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toContain("Content-Security-Policy-Report-Only");
  expect(csp).not.toContain("'unsafe-inline' 'unsafe-eval'");
  expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(response.headers.get("Permissions-Policy")).toBe("browsing-topics=(), interest-cohort=()");
}

describe("www Lighthouse security headers", () => {
  it("sets an enforced nonce CSP and COOP on public route responses", async () => {
    const authorizeProtectedRoute = vi.fn();
    const response = await proxyWithSecurity(
      makeRequest("/"),
      {} as Parameters<ProxyModule["default"]>[1],
      authorizeProtectedRoute,
    );

    expectSecurityHeaders(response);
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBeNull();
    expect(authorizeProtectedRoute).not.toHaveBeenCalled();
  });

  it("keeps Clerk auth for protected routes while preserving security headers", async () => {
    const authorizeProtectedRoute = vi.fn(async () => {
      const response = NextResponse.next();
      response.headers.set("x-clerk-checked", "1");
      return response;
    });
    const response = await proxyWithSecurity(
      makeRequest("/dashboard"),
      {} as Parameters<ProxyModule["default"]>[1],
      authorizeProtectedRoute,
    );

    expect(authorizeProtectedRoute).toHaveBeenCalledOnce();
    expect(response.headers.get("x-clerk-checked")).toBe("1");
    expectSecurityHeaders(response);
    expect(response.headers.get("x-middleware-request-x-nonce")).toBeTruthy();
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBeNull();
  });

  it("matches protected routes and broad non-static document routes", async () => {
    expect(config.matcher).toEqual([
      "/dashboard(.*)",
      "/admin(.*)",
      "/((?!_next|.*\\..*).*)",
    ]);
  });
});
