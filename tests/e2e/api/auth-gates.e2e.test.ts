import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Authentication gates", () => {
  let gw: TestGateway;
  const AUTH_TOKEN = "test-secret";

  beforeAll(async () => {
    gw = await startTestGateway({ authToken: AUTH_TOKEN });
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("allows unauthenticated access to /health", async () => {
    const res = await fetch(`${gw.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("rejects /api/tasks without token", async () => {
    const res = await fetch(`${gw.url}/api/tasks`);
    expect(res.status).toBe(401);
  });

  it("rejects /api/tasks with wrong token", async () => {
    const res = await fetch(`${gw.url}/api/tasks`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("allows /api/tasks with correct token", async () => {
    const res = await fetch(`${gw.url}/api/tasks`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects /api/message without token", async () => {
    const res = await fetch(`${gw.url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("allows /api/identity with correct token", async () => {
    const res = await fetch(`${gw.url}/api/identity`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects /api/channels/status without token", async () => {
    const res = await fetch(`${gw.url}/api/channels/status`);
    expect(res.status).toBe(401);
  });

  it("allows /api/channels/status with correct token", async () => {
    const res = await fetch(`${gw.url}/api/channels/status`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});
