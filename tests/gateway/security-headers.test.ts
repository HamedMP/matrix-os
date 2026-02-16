import { describe, it, expect } from "vitest";
import {
  securityHeadersMiddleware,
  SECURITY_HEADERS,
} from "../../packages/gateway/src/security/headers.js";

function mockContext(path: string) {
  const responseHeaders = new Map<string, string>();
  return {
    ctx: {
      req: { path },
      header: (name: string, value: string) => responseHeaders.set(name, value),
    } as any,
    responseHeaders,
  };
}

describe("T805: Security headers middleware", () => {
  it("sets X-Content-Type-Options", async () => {
    const mw = securityHeadersMiddleware();
    const { ctx, responseHeaders } = mockContext("/api/message");
    await mw(ctx, async () => {});
    expect(responseHeaders.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets X-Frame-Options to SAMEORIGIN for API routes", async () => {
    const mw = securityHeadersMiddleware();
    const { ctx, responseHeaders } = mockContext("/api/message");
    await mw(ctx, async () => {});
    expect(responseHeaders.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });

  it("skips X-Frame-Options for /files/ paths (app iframes)", async () => {
    const mw = securityHeadersMiddleware();
    const { ctx, responseHeaders } = mockContext("/files/modules/hello/index.html");
    await mw(ctx, async () => {});
    expect(responseHeaders.has("X-Frame-Options")).toBe(false);
    expect(responseHeaders.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets Referrer-Policy", async () => {
    const mw = securityHeadersMiddleware();
    const { ctx, responseHeaders } = mockContext("/");
    await mw(ctx, async () => {});
    expect(responseHeaders.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets X-XSS-Protection", async () => {
    const mw = securityHeadersMiddleware();
    const { ctx, responseHeaders } = mockContext("/");
    await mw(ctx, async () => {});
    expect(responseHeaders.get("X-XSS-Protection")).toBe("1; mode=block");
  });

  it("exports SECURITY_HEADERS constant", () => {
    expect(SECURITY_HEADERS).toBeDefined();
    expect(Object.keys(SECURITY_HEADERS).length).toBeGreaterThan(0);
  });
});
