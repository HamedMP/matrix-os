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

  it("rejects protected paths when no token configured", async () => {
    const previous = process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV;
    delete process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV;
    const mw = authMiddleware(undefined);
    const { ctx, getBody } = mockContext("/api/message");
    let nextCalled = false;
    try {
      await mw(ctx, async () => {
        nextCalled = true;
      });
    } finally {
      if (previous === undefined) {
        delete process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV;
      } else {
        process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV = previous;
      }
    }
    expect(nextCalled).toBe(false);
    expect(getBody()).toEqual({ error: "Unauthorized" });
  });

  it("allows explicit insecure dev mode when no token configured", async () => {
    const previous = process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV;
    process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV = "1";
    const mw = authMiddleware(undefined);
    const { ctx } = mockContext("/api/message");
    let nextCalled = false;
    try {
      await mw(ctx, async () => {
        nextCalled = true;
      });
    } finally {
      if (previous === undefined) {
        delete process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV;
      } else {
        process.env.MATRIX_AUTH_ALLOW_INSECURE_DEV = previous;
      }
    }
    expect(nextCalled).toBe(true);
  });

  it("rejects token with different length (timing-safe)", async () => {
    const mw = authMiddleware("abcdefghijklmnopqrstuvwx");
    const { ctx, getBody } = mockContext("/api/message", "Bearer short");
    await mw(ctx, async () => {});
    expect(getBody()).toEqual({ error: "Unauthorized" });
  });

  it("rejects bearer tokens with extra trailing bytes", async () => {
    const mw = authMiddleware("my-secret-token-that-is-long");
    const { ctx, getBody } = mockContext(
      "/api/message",
      "Bearer my-secret-token-that-is-long_garbage",
    );
    await mw(ctx, async () => {});
    expect(getBody()).toEqual({ error: "Unauthorized" });
  });
});
