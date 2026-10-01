import { afterEach, describe, expect, it, vi } from "vitest";
import { createClerkRequest } from "@clerk/backend/internal";
import { NextRequest, NextResponse } from "next/server";
import { withClerkPublicOrigin } from "../../shell/src/lib/clerk-proxy-origin";

const PUBLIC_ORIGIN = "https://preview.matrix-os.com";
const NETWORK_ORIGIN = "http://matrix-platform-preview-jqxkjdhtkq-ey.a.run.app";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.doUnmock("@clerk/nextjs/server");
});

async function loadProxy(observer?: (request: NextRequest) => void | Promise<void>) {
  vi.resetModules();
  vi.stubEnv("E2E_TEST_BYPASS", "0");
  vi.stubEnv("MATRIX_SELF_HOSTED", "0");
  vi.stubEnv("MATRIX_APP_ORIGIN", PUBLIC_ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_MATRIX_APP_URL", "");
  vi.doMock("@clerk/nextjs/server", () => ({
    // The real SDK derives the handshake URL before invoking our callback.
    clerkMiddleware: vi.fn(() => async (request: NextRequest) => {
      await observer?.(request);
      const redirect = new URL("https://clerk.example.test/v1/client/handshake");
      redirect.searchParams.set("redirect_url", createClerkRequest(request).clerkUrl.href);
      return NextResponse.redirect(redirect);
    }),
  }));
  return (await import("../../shell/src/proxy")).proxy;
}

function incoming(path = "/shared", init: RequestInit = {}) {
  return new NextRequest(NETWORK_ORIGIN + path, {
    ...init,
    headers: {
      host: "127.0.0.1:3200",
      "x-forwarded-host": "matrix-platform-preview-jqxkjdhtkq-ey.a.run.app",
      "x-forwarded-proto": "http",
      ...init.headers,
    },
  });
}

describe("Clerk handshake behind the local platform auth shell", () => {
  it("uses the configured public HTTPS origin before Clerk invokes app auth", async () => {
    const proxy = await loadProxy();
    const response = await proxy(incoming("/shared?filter=invited"), {} as Parameters<typeof proxy>[1]);
    const handshake = new URL(response!.headers.get("location")!);
    expect(handshake.searchParams.get("redirect_url")).toBe(PUBLIC_ORIGIN + "/shared?filter=invited");
  });

  it("keeps Next's network URL and restores transport headers after authentication", async () => {
    const request = incoming();
    const original = [...request.headers.entries()];
    const proxy = await loadProxy((observed) => {
      expect(observed.url).toBe(NETWORK_ORIGIN + "/shared");
      expect(createClerkRequest(observed).clerkUrl.origin).toBe(PUBLIC_ORIGIN);
    });
    await proxy(request, {} as Parameters<typeof proxy>[1]);
    expect([...request.headers.entries()]).toEqual(original);
  });

  it("restores headers if authentication fails", async () => {
    const request = incoming();
    const original = [...request.headers.entries()];
    const proxy = await loadProxy(() => { throw new Error("fixture authentication failed"); });
    await expect(proxy(request, {} as Parameters<typeof proxy>[1])).rejects.toThrow("fixture authentication failed");
    expect([...request.headers.entries()]).toEqual(original);
  });

  it("preserves a Server Action body, cookie and method", async () => {
    const request = incoming("/shared", { method: "POST", body: "dummy-action-data", headers: { cookie: "fixture=value" } });
    const proxy = await loadProxy(async (observed) => {
      expect(observed.method).toBe("POST");
      expect(observed.headers.get("cookie")).toBe("fixture=value");
      expect(await observed.clone().text()).toBe("dummy-action-data");
      expect(createClerkRequest(observed).clerkUrl.origin).toBe(PUBLIC_ORIGIN);
    });
    await proxy(request, {} as Parameters<typeof proxy>[1]);
  });
});


describe("Clerk response transport overrides", () => {
  it("restores local transport overrides while retaining signed auth metadata", async () => {
    vi.stubEnv("MATRIX_APP_ORIGIN", PUBLIC_ORIGIN);
    const request = incoming();
    const response = await withClerkPublicOrigin(request, () => {
      const headers = new Headers(request.headers);
      headers.set("x-clerk-auth-signature", "fixture-signature");
      return NextResponse.next({ request: { headers } });
    });
    expect(response.headers.get("x-middleware-request-x-forwarded-host")).toBe("matrix-platform-preview-jqxkjdhtkq-ey.a.run.app");
    expect(response.headers.get("x-middleware-request-x-forwarded-proto")).toBe("http");
    expect(response.headers.get("x-middleware-request-x-clerk-auth-signature")).toBe("fixture-signature");
  });

  it("removes injected transport overrides when the original request had none", async () => {
    vi.stubEnv("MATRIX_APP_ORIGIN", PUBLIC_ORIGIN);
    const request = new NextRequest("http://localhost:3200/shared");
    const response = await withClerkPublicOrigin(request, () => NextResponse.next({ request: { headers: request.headers } }));
    expect(response.headers.has("x-middleware-request-x-forwarded-host")).toBe(false);
    expect(response.headers.has("x-middleware-request-x-forwarded-proto")).toBe(false);
    expect(request.headers.has("x-forwarded-host")).toBe(false);
    expect(request.headers.has("x-forwarded-proto")).toBe(false);
  });

  it("preserves local development headers when no public origin is configured", async () => {
    vi.stubEnv("MATRIX_APP_ORIGIN", "");
    vi.stubEnv("NEXT_PUBLIC_MATRIX_APP_URL", "");
    const request = incoming();
    const original = [...request.headers.entries()];
    const result = await withClerkPublicOrigin(request, () => {
      expect([...request.headers.entries()]).toEqual(original);
      return "local-result";
    });
    expect(result).toBe("local-result");
  });
});
