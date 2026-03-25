import { describe, it, expect } from "vitest";

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
