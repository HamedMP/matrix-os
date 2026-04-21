import { describe, it, expect } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";

const WEBHOOK_PROVIDERS = new Set(["twilio", "mock"]);

function mockContext(path: string, authHeader?: string, queryToken?: string, ip?: string) {
  const url = queryToken
    ? `http://localhost:4000${path}?token=${queryToken}`
    : `http://localhost:4000${path}`;
  return {
    req: {
      path,
      url,
      header: (name: string) => {
        const lower = name.toLowerCase();
        if (name === "Authorization") return authHeader;
        if ((name === "X-Forwarded-For" || lower === "x-forwarded-for") && ip) return ip;
        return undefined;
      },
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
    const mw = authMiddleware("secret-token", { webhookProviders: WEBHOOK_PROVIDERS });
    let nextCalled = false;
    await mw(mockContext("/voice/webhook/twilio"), async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("rejects webhook for unregistered provider", async () => {
    const mw = authMiddleware("secret-token", { webhookProviders: WEBHOOK_PROVIDERS });
    let nextCalled = false;
    const result = await mw(mockContext("/voice/webhook/unknown"), async () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
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

  it("allows /ws/terminal with query token", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    await mw(
      mockContext("/ws/terminal", undefined, "secret-token", "10.0.0.1"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it("rejects REST endpoint with query token (only WS allowed)", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    const result = await mw(
      mockContext("/api/message", undefined, "secret-token", "10.0.0.2"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(401);
  });

  it("rate-limits webhook endpoint", async () => {
    const mw = authMiddleware("secret-token", { webhookProviders: WEBHOOK_PROVIDERS });
    const testIp = "10.99.99.99";
    // Exhaust the rate limiter for this IP
    for (let i = 0; i < 10; i++) {
      await mw(mockContext("/voice/webhook/twilio", undefined, undefined, testIp), async () => {});
    }
    let nextCalled = false;
    const result = await mw(
      mockContext("/voice/webhook/twilio", undefined, undefined, testIp),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(429);
  });

  it("allows integrations webhook without bearer token (HMAC handled downstream)", async () => {
    const mw = authMiddleware("secret-token");
    let nextCalled = false;
    await mw(
      mockContext("/api/integrations/webhook/connected"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it("rate-limits integrations webhook separately from auth failures", async () => {
    // The integrations webhook limiter is more permissive (120/min) than the
    // failed-auth limiter (10/min) because legit providers retry aggressively.
    // A burst from a single source IP must still eventually be throttled so
    // HMAC verification can't become a free DoS target. This test fires 121
    // webhook requests from one IP and verifies the last one gets 429.
    const mw = authMiddleware("secret-token");
    const testIp = "10.88.88.88";
    for (let i = 0; i < 120; i++) {
      await mw(
        mockContext("/api/integrations/webhook/connected", undefined, undefined, testIp),
        async () => {},
      );
    }
    let nextCalled = false;
    const result = await mw(
      mockContext("/api/integrations/webhook/connected", undefined, undefined, testIp),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(result?.status).toBe(429);
  });

  it("isolates integrations webhook limiter from failed-auth limiter", async () => {
    // Fire 10 bad auth attempts to exhaust the failed-auth limiter for an IP,
    // then send a webhook request from that same IP -- it should pass because
    // the webhook limiter has its own counter.
    const mw = authMiddleware("secret-token");
    const testIp = "10.77.77.77";
    for (let i = 0; i < 11; i++) {
      await mw(
        mockContext("/api/message", "Bearer wrong", undefined, testIp),
        async () => {},
      );
    }
    let nextCalled = false;
    await mw(
      mockContext("/api/integrations/webhook/connected", undefined, undefined, testIp),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it("falls back to x-forwarded-for when proxy IP headers are absent", async () => {
    const mw = authMiddleware("secret-token");
    const noisyIp = "198.51.100.10";
    for (let i = 0; i < 120; i++) {
      await mw(
        mockContext("/api/integrations/webhook/connected", undefined, undefined, noisyIp),
        async () => {},
      );
    }

    let nextCalled = false;
    await mw(
      mockContext("/api/integrations/webhook/connected", undefined, undefined, "198.51.100.11"),
      async () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });
});
