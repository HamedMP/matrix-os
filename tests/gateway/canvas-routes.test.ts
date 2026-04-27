import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CanvasConflictError } from "../../packages/gateway/src/canvas/repository.js";
import { createCanvasRoutes, type CanvasRouteService } from "../../packages/gateway/src/canvas/routes.js";

function createApp(service: CanvasRouteService, userId: string | null = "user_a") {
  const app = new Hono();
  app.route("/api/canvases", createCanvasRoutes({
    service,
    getUserId: () => {
      if (!userId) throw new Error("missing auth");
      return userId;
    },
  }));
  return app;
}

const service: CanvasRouteService = {
  listCanvases: vi.fn().mockResolvedValue({ canvases: [], nextCursor: null }),
  createCanvas: vi.fn().mockResolvedValue({ canvasId: "cnv_0123456789abcdef", revision: 1 }),
  getCanvas: vi.fn().mockResolvedValue({ document: { id: "cnv_0123456789abcdef" }, linkedState: {} }),
  replaceCanvas: vi.fn().mockResolvedValue({ revision: 2, updatedAt: "2026-04-27T00:00:00.000Z" }),
  deleteCanvas: vi.fn().mockResolvedValue({ ok: true }),
  exportCanvas: vi.fn().mockResolvedValue({ canvas: {}, linkedSummaries: {}, exportedAt: "2026-04-27T00:00:00.000Z" }),
  executeAction: vi.fn().mockResolvedValue({ ok: true, result: { kind: "noop" } }),
};

describe("canvas routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests", async () => {
    const app = createApp(service, null);
    const res = await app.request("/api/canvases");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("applies Hono body limits before request handling", async () => {
    const createCanvas = vi.fn();
    const app = createApp({ ...service, createCanvas });
    const res = await app.request("/api/canvases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x".repeat(300 * 1024), scopeType: "global", scopeRef: null }),
    });
    expect(res.status).toBe(413);
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it("returns generic client errors without raw internals", async () => {
    const app = createApp({
      ...service,
      getCanvas: vi.fn().mockRejectedValue(new Error("postgres://secret /home/deploy stack")),
    });

    const res = await app.request("/api/canvases/cnv_0123456789abcdef");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Canvas request failed" });
  });

  it("returns CRUD status codes and conflict responses", async () => {
    const app = createApp({
      ...service,
      replaceCanvas: vi.fn().mockRejectedValue(new CanvasConflictError("cnv_0123456789abcdef", 4)),
    });

    const createRes = await app.request("/api/canvases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "PR 57", scopeType: "global", scopeRef: null }),
    });
    expect(createRes.status).toBe(201);

    const getRes = await app.request("/api/canvases/cnv_0123456789abcdef");
    expect(getRes.status).toBe(200);

    const putRes = await app.request("/api/canvases/cnv_0123456789abcdef", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseRevision: 1,
        document: { schemaVersion: 1, nodes: [], edges: [], viewStates: [], displayOptions: {} },
      }),
    });
    expect(putRes.status).toBe(409);
    await expect(putRes.json()).resolves.toMatchObject({ error: "Canvas conflict", latestRevision: 4 });

    const deleteRes = await app.request("/api/canvases/cnv_0123456789abcdef", { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
  });

  it("validates list query parameters at the route boundary", async () => {
    const listCanvases = vi.fn();
    const app = createApp({ ...service, listCanvases });

    const res = await app.request("/api/canvases?scopeType=../../system&q=x");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
    expect(listCanvases).not.toHaveBeenCalled();
  });

  it("validates node ids from path parameters before patching", async () => {
    const patchCanvasNode = vi.fn();
    const app = createApp({ ...service, patchCanvasNode });

    const res = await app.request("/api/canvases/cnv_0123456789abcdef/nodes/not_a_node", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 1, updates: { metadata: { label: "bad" } } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
    expect(patchCanvasNode).not.toHaveBeenCalled();
  });
});
