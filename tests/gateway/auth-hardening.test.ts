import { describe, it, expect } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";

function mockContext(path: string, authHeader?: string) {
  let status = 200;
  let body: unknown = undefined;
  return {
    ctx: {
      req: {
        path,
        header: (name: string) =>
          name === "Authorization" ? authHeader : undefined,
      },
      json: (data: unknown, s?: number) => {
        body = data;
        if (s) status = s;
        return new Response(JSON.stringify(data), { status });
      },
    } as any,
    getStatus: () => status,
    getBody: () => body,
  };
}

describe("T828: Auth hardening", () => {
  it("allows valid bearer token", async () => {
    const mw = authMiddleware("my-secret-token-that-is-long");
    const { ctx } = mockContext(
      "/api/message",
      "Bearer my-secret-token-that-is-long",
    );
    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("rejects invalid bearer token", async () => {
    const mw = authMiddleware("my-secret-token-that-is-long");
    const { ctx, getBody } = mockContext(
      "/api/message",
      "Bearer wrong-token",
    );
    const resp = await mw(ctx, async () => {});
    expect(getBody()).toEqual({ error: "Unauthorized" });
  });

  it("rejects missing Authorization header", async () => {
    const mw = authMiddleware("my-secret-token-that-is-long");
    const { ctx, getBody } = mockContext("/api/message");
    await mw(ctx, async () => {});
    expect(getBody()).toEqual({ error: "Unauthorized" });
  });

  it("allows public paths without auth", async () => {
    const mw = authMiddleware("my-secret-token-that-is-long");
    const { ctx } = mockContext("/health");
    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("skips auth when no token configured", async () => {
    const mw = authMiddleware(undefined);
    const { ctx } = mockContext("/api/message");
    let nextCalled = false;
    await mw(ctx, async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("rejects token with different length (timing-safe)", async () => {
    const mw = authMiddleware("abcdefghijklmnopqrstuvwx");
    const { ctx, getBody } = mockContext("/api/message", "Bearer short");
    await mw(ctx, async () => {});
    expect(getBody()).toEqual({ error: "Unauthorized" });
  });
});
