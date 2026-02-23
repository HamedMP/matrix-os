import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";

describe("E2E: Conversation Management", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway();
  });

  afterAll(async () => {
    await gw?.close();
  });

  it("GET /api/conversations returns empty list initially", async () => {
    const res = await fetch(`${gw.url}/api/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it("POST /api/conversations creates a new conversation", async () => {
    const res = await fetch(`${gw.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
  });

  it("POST /api/conversations with channel prefix", async () => {
    const res = await fetch(`${gw.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "telegram" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^telegram:/);
  });

  it("GET /api/conversations lists created conversations", async () => {
    const res = await fetch(`${gw.url}/api/conversations`);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(2);
    for (const conv of list) {
      expect(conv).toHaveProperty("id");
      expect(conv).toHaveProperty("preview");
      expect(conv).toHaveProperty("messageCount");
      expect(conv).toHaveProperty("createdAt");
      expect(conv).toHaveProperty("updatedAt");
    }
  });

  it("DELETE /api/conversations/:id removes a conversation", async () => {
    const createRes = await fetch(`${gw.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { id } = await createRes.json();

    const deleteRes = await fetch(`${gw.url}/api/conversations/${id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json();
    expect(body.ok).toBe(true);
  });

  it("DELETE /api/conversations/nonexistent returns 404", async () => {
    const res = await fetch(`${gw.url}/api/conversations/nonexistent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  it("conversation list shrinks after delete", async () => {
    const beforeRes = await fetch(`${gw.url}/api/conversations`);
    const before = await beforeRes.json();
    const countBefore = before.length;

    const createRes = await fetch(`${gw.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { id } = await createRes.json();

    const midRes = await fetch(`${gw.url}/api/conversations`);
    const mid = await midRes.json();
    expect(mid.length).toBe(countBefore + 1);

    await fetch(`${gw.url}/api/conversations/${id}`, { method: "DELETE" });

    const afterRes = await fetch(`${gw.url}/api/conversations`);
    const after = await afterRes.json();
    expect(after.length).toBe(countBefore);
  });
});
