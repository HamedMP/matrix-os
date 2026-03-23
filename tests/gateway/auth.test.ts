import { describe, it, expect } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";

function mockContext(path: string, authHeader?: string, queryToken?: string) {
  const url = queryToken
    ? `http://localhost:4000${path}?token=${queryToken}`
    : `http://localhost:4000${path}`;
  return {
    req: {
      path,
      url,
      header: (name: string) => name === "Authorization" ? authHeader : undefined,
    },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
  } as any;
}

describe("T133: Auth token middleware", () => {
  it("allows all requests when no token configured", async () => {
    const mw = authMiddleware(undefined);
    let nextCalled = false;
    await mw(mockContext("/api/message"), async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("allows health endpoint without token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    await mw(mockContext("/health"), async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("rejects API requests without token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(mockContext("/api/message"), async () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("rejects API requests with wrong token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(
      mockContext("/api/message", "Bearer wrong-token"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("allows API requests with correct token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    await mw(
      mockContext("/api/message", "Bearer secret-token"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it("allows WebSocket path with correct token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    await mw(
      mockContext("/ws", "Bearer secret-token"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it("rejects WebSocket path without token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(mockContext("/ws"), async () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("returns error body on 401", async () => {
    const mw = authMiddleware("secret-token");
    const result = await mw(mockContext("/api/message"), async () => {});
    expect(result?.body).toHaveProperty("error");
  });

  it("allows voice webhook without auth token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    await mw(mockContext("/voice/webhook/twilio"), async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("allows WebSocket with query token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    await mw(
      mockContext("/ws/voice", undefined, "secret-token"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it("rejects WebSocket with wrong query token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(
      mockContext("/ws/voice", undefined, "wrong-token"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("rejects REST endpoint with query token (only WS allowed)", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(
      mockContext("/api/message", undefined, "secret-token"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("rate-limits webhook endpoint", async () => {
    const mw = authMiddleware("secret-token");
    // Exhaust the rate limiter
    for (let i = 0; i < 10; i++) {
      await mw(mockContext("/voice/webhook/twilio"), async () => {});
    }
    let nextCalled = false;
    const result = await mw(
      mockContext("/voice/webhook/twilio"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(429);
  });
});
