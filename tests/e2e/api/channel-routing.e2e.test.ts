import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Channel status + Message API", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway({
      spawnFn: async function* () {
        yield {
          type: "result",
          data: { sessionId: "test-session", cost: 0, tokensIn: 0, tokensOut: 0 },
        };
      },
    });
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("GET /api/channels/status returns object", async () => {
    const res = await fetch(`${gw.url}/api/channels/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
  });

  it("GET /api/channels/status with configured channels shows status", async () => {
    const gwWithChannels = await startTestGateway({
      config: {
        channels: {
          telegram: { enabled: false, token: "fake", allowFrom: [] },
        },
      },
    });

    try {
      const res = await fetch(`${gwWithChannels.url}/api/channels/status`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body).toBe("object");
      if (body.telegram) {
        expect(["disabled", "stopped", "error", "connected"]).toContain(
          body.telegram,
        );
      }
    } finally {
      await gwWithChannels.close();
    }
  });

  it("POST /api/message dispatches through the gateway", async () => {
    const res = await gw.request("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /api/message rejects malformed JSON before dispatch", async () => {
    const res = await fetch(`${gw.url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
  });

  it("POST /api/message rejects schema-invalid message bodies before dispatch", async () => {
    const missingText = await fetch(`${gw.url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingText.status).toBe(400);
    expect(await missingText.json()).toEqual({ error: "Invalid message body" });

    const emptyText = await fetch(`${gw.url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(emptyText.status).toBe(400);
    expect(await emptyText.json()).toEqual({ error: "Invalid message body" });
  });

  it("POST /api/message with sessionId is accepted", async () => {
    const res = await gw.request("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "with session",
        sessionId: "test-session-456",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /api/message with from field is accepted", async () => {
    const res = await gw.request("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "from external",
        from: { handle: "@test:matrix.org", displayName: "Test User" },
      }),
    });
    expect(res.status).toBe(200);
  });

  it("GET /health returns channel status in response", async () => {
    const res = await fetch(`${gw.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.channels).toBeDefined();
    expect(typeof body.channels).toBe("object");
  });

  it("GET /api/identity returns handle data", async () => {
    const res = await fetch(`${gw.url}/api/identity`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
  });

  it("GET /api/system/info returns system info", async () => {
    const res = await fetch(`${gw.url}/api/system/info`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
    expect(typeof body).toBe("object");
  });

  it("GET /api/profile returns profile or 404", async () => {
    const res = await fetch(`${gw.url}/api/profile`);
    expect([200, 404]).toContain(res.status);
  });

  it("GET /api/ai-profile returns ai-profile or 404", async () => {
    const res = await fetch(`${gw.url}/api/ai-profile`);
    expect([200, 404]).toContain(res.status);
  });
});
