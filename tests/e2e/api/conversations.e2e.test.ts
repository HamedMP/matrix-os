import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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

  it("POST /api/conversations preserves bodyless create compatibility", async () => {
    const res = await fetch(`${gw.url}/api/conversations`, { method: "POST" });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("POST /api/conversations preserves non-JSON create compatibility", async () => {
    const res = await fetch(`${gw.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "legacy-client-body",
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("GET /api/conversations/:id returns the stored transcript in order", async () => {
    const conversation = {
      id: "mobile-session-1",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_200,
      messages: [
        { role: "user", content: "first", timestamp: 1_700_000_000_100 },
        { role: "assistant", content: "second", timestamp: 1_700_000_000_200 },
      ],
    };
    await writeFile(
      join(gw.homePath, "system", "conversations", `${conversation.id}.json`),
      JSON.stringify(conversation),
    );

    const res = await fetch(`${gw.url}/api/conversations/${conversation.id}`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(conversation);
  });

  it("GET /api/conversations/:id returns 404 for an unknown transcript", async () => {
    const res = await fetch(`${gw.url}/api/conversations/missing-session`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "conversation_not_found" });
  });

  it("GET /api/conversations/:id rejects unsafe identifiers", async () => {
    const res = await fetch(`${gw.url}/api/conversations/unsafe%24id`);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid conversation id" });
  });

  it("GET /api/conversations/:id/search stays within the selected transcript", async () => {
    const selected = {
      id: "selected-search-session",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_100,
      messages: [
        { role: "user", content: "shared route search phrase", timestamp: 1_700_000_000_100 },
      ],
    };
    const other = {
      ...selected,
      id: "other-search-session",
      messages: [
        { role: "user", content: "shared route search phrase", timestamp: 1_700_000_000_200 },
      ],
    };
    await Promise.all([selected, other].map((conversation) => writeFile(
      join(gw.homePath, "system", "conversations", `${conversation.id}.json`),
      JSON.stringify(conversation),
    )));

    const res = await fetch(
      `${gw.url}/api/conversations/${selected.id}/search?q=shared%20route%20search%20phrase`,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ sessionId: selected.id }),
    ]);
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
