import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ clerkMiddleware: (handler: (auth: unknown, request: unknown) => unknown) => (request: unknown) => handler(session.auth, request), auth: session.auth }));
vi.mock("../../shell/src/lib/clerk-proxy-origin", () => ({ withClerkPublicOrigin: (_request: unknown, run: () => unknown) => run() }));
import { proxy } from "../../shell/src/proxy";
const event = {} as Parameters<typeof proxy>[1];
afterEach(() => vi.unstubAllEnvs());

describe("shared preview does not inherit personal auth bypasses", () => {
  it("hides disabled preview even when the existing E2E bypass is enabled", async () => {
    vi.stubEnv("E2E_TEST_BYPASS", "1");
    const response = await proxy(new NextRequest("https://shell.test/workspace"), event);
    expect(response.status).toBe(404);
  });
  it("requires Clerk auth before rewriting shared APIs even when E2E bypass is enabled", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_SPIKE", "1");
    vi.stubEnv("E2E_TEST_BYPASS", "1");
    session.auth.mockResolvedValue({ userId: null });
    const response = await proxy(new NextRequest("https://shell.test/__shared-workspace/api/files"), event);
    expect(response.status).toBe(401);
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });
  it("rewrites verified shared data to the bounded internal forwarder", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_SPIKE", "1");
    session.auth.mockResolvedValue({ userId: "owner" });
    const response = await proxy(new NextRequest("https://shell.test/__shared-workspace/api/files?path=notes"), event);
    expect(response.headers.get("x-middleware-rewrite")).toBe("https://shell.test/workspace/api/api/files?path=notes");
  });
  it("does not rewrite a verified desktop document to a VPS", async () => {
    vi.stubEnv("MATRIX_SHARED_WORKSPACE_SPIKE", "1");
    session.auth.mockResolvedValue({ userId: "owner" });
    const response = await proxy(new NextRequest("https://shell.test/workspace"), event);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });
  it("continues to route ordinary personal APIs through their existing gateway", async () => {
    vi.stubEnv("E2E_TEST_BYPASS", "1");
    const response = await proxy(new NextRequest("https://shell.test/api/files"), event);
    expect(response.headers.get("x-middleware-rewrite")).toBe("http://localhost:4000/api/files");
  });
});
