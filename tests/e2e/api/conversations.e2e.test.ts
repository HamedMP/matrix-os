import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { KernelConfig, KernelEvent } from "@matrix-os/kernel";
import { startTestGateway, type TestGateway } from "../fixtures/gateway.js";
import { connectWs } from "../fixtures/ws-client.js";

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
    expect(body.error).toEqual({ code: "conversation_not_found" });
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

describe("E2E: Conversation project context dispatch", () => {
  let gw: TestGateway;
  const observedConfigs: KernelConfig[] = [];

  beforeAll(async () => {
    gw = await startTestGateway({
      spawnFn: async function* (_message, config) {
        observedConfigs.push(config);
        const sessionId = config.sessionId ?? `new-context-session-${observedConfigs.length}`;
        yield { type: "init", sessionId } as KernelEvent;
        yield {
          type: "result",
          data: { sessionId, cost: 0, turns: 1 },
        } as KernelEvent;
      },
    });
  });

  afterAll(async () => {
    await gw?.close();
  });

  async function createConversation(): Promise<string> {
    const response = await fetch(`${gw.url}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  async function createScratchProject(slug: string): Promise<void> {
    const response = await fetch(`${gw.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "scratch", name: slug, slug }),
    });
    expect(response.status).toBe(201);
  }

  it("resolves the persisted project and passes only its internal working directory", async () => {
    const slug = "context-project";
    await createScratchProject(slug);
    const sessionId = await createConversation();
    const patch = await fetch(`${gw.url}/api/conversations/${sessionId}/context`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: slug }),
    });
    expect(patch.status).toBe(200);

    const ws = await connectWs(gw.url.replace("http", "ws") + "/ws");
    try {
      ws.send({ type: "message", text: "pwd", requestId: "context-ready", sessionId });
      const ack = await ws.waitFor("client:ack", 5_000);
      expect(ack).toMatchObject({ status: "accepted", actionId: "context-ready" });
      await ws.waitFor("kernel:result", 5_000);

      expect(observedConfigs.at(-1)).toMatchObject({
        homePath: gw.homePath,
        workingDirectory: await realpath(join(gw.homePath, "projects", slug, "repo")),
      });
    } finally {
      ws.close();
    }
  });

  it("blocks stale project context before dispatch without exposing a path", async () => {
    const slug = "stale-context-project";
    await createScratchProject(slug);
    const sessionId = await createConversation();
    const patch = await fetch(`${gw.url}/api/conversations/${sessionId}/context`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: slug }),
    });
    expect(patch.status).toBe(200);
    const archive = await fetch(`${gw.url}/api/projects/${slug}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "archive" }),
    });
    expect(archive.status).toBe(200);
    const dispatchCount = observedConfigs.length;

    const ws = await connectWs(gw.url.replace("http", "ws") + "/ws");
    try {
      ws.send({ type: "message", text: "pwd", requestId: "context-stale", sessionId });
      const ack = await ws.waitFor("client:ack", 5_000);
      expect(ack).toMatchObject({ status: "rejected", actionId: "context-stale" });
      const error = await ws.waitFor("kernel:error", 5_000);
      expect(error).toEqual({
        type: "kernel:error",
        message: "conversation_context_unavailable",
      });
      expect(JSON.stringify(error)).not.toContain(gw.homePath);
      expect(observedConfigs).toHaveLength(dispatchCount);
    } finally {
      ws.close();
    }
  });

  it("keeps no-context conversations on the Matrix home default", async () => {
    const sessionId = await createConversation();
    const ws = await connectWs(gw.url.replace("http", "ws") + "/ws");
    try {
      ws.send({ type: "message", text: "pwd", requestId: "context-empty", sessionId });
      await ws.waitFor("kernel:result", 5_000);

      expect(observedConfigs.at(-1)?.homePath).toBe(gw.homePath);
      expect(observedConfigs.at(-1)?.workingDirectory).toBeUndefined();
    } finally {
      ws.close();
    }
  });
});
