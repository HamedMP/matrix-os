import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CanvasConflictError } from "../../packages/gateway/src/canvas/repository.js";
import { createCanvasRoutes, type CanvasRouteService } from "../../packages/gateway/src/canvas/routes.js";
import {
  InvalidRequestPrincipalError,
  MissingRequestPrincipalError,
  RequestPrincipalMisconfiguredError,
} from "../../packages/gateway/src/request-principal.js";

function createApp(
  service: CanvasRouteService,
  userIdOrResolver: string | null | (() => string) = "user_a",
  broadcastCanvasUpdate?: Parameters<typeof createCanvasRoutes>[0]["broadcastCanvasUpdate"],
) {
  const app = new Hono();
  app.route("/api/canvases", createCanvasRoutes({
    service,
    getUserId: () => {
      if (typeof userIdOrResolver === "function") return userIdOrResolver();
      if (!userIdOrResolver) throw new Error("missing auth");
      return userIdOrResolver;
    },
    broadcastCanvasUpdate,
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
  uploadCanvasAsset: vi.fn().mockResolvedValue({
    assetId: "asset_0123456789abcdef",
    path: "system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png",
    mimeType: "image/png",
    sizeBytes: 8,
    originalName: "screenshot.png",
  }),
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

  it("maps request principal missing identity to generic unauthorized", async () => {
    const app = createApp(service, () => {
      throw new MissingRequestPrincipalError();
    });
    const res = await app.request("/api/canvases");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("maps request principal misconfiguration to a generic server error", async () => {
    const app = createApp(service, () => {
      throw new RequestPrincipalMisconfiguredError();
    });
    const res = await app.request("/api/canvases");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Canvas request failed" });
  });

  it("does not expose malformed principal values to clients", async () => {
    const app = createApp(service, () => {
      throw new InvalidRequestPrincipalError("jwt");
    });
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

  it("applies a body limit to delete requests before request handling", async () => {
    const deleteCanvas = vi.fn();
    const app = createApp({ ...service, deleteCanvas });
    const res = await app.request("/api/canvases/cnv_0123456789abcdef", {
      method: "DELETE",
      headers: { "Content-Type": "text/plain", "Content-Length": "2048" },
      body: "x".repeat(2048),
    });

    expect(res.status).toBe(413);
    expect(deleteCanvas).not.toHaveBeenCalled();
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

  it("broadcasts canvas updates after replace, patch, and delete mutations", async () => {
    const updatedAt = "2026-04-27T00:00:00.000Z";
    const broadcastCanvasUpdate = vi.fn();
    const replaceCanvas = vi.fn().mockResolvedValue({ revision: 2, updatedAt });
    const patchCanvasNode = vi.fn().mockResolvedValue({ revision: 3, updatedAt });
    const app = createApp({ ...service, replaceCanvas, patchCanvasNode }, "user_a", broadcastCanvasUpdate);

    await app.request("/api/canvases/cnv_0123456789abcdef", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseRevision: 1,
        document: { schemaVersion: 1, nodes: [], edges: [], viewStates: [], displayOptions: {} },
      }),
    });
    await app.request("/api/canvases/cnv_0123456789abcdef/nodes/node_0123456789abcdef", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 2, updates: { metadata: { label: "updated" } } }),
    });
    await app.request("/api/canvases/cnv_0123456789abcdef", {
      method: "DELETE",
    });

    expect(broadcastCanvasUpdate).toHaveBeenNthCalledWith(1, "cnv_0123456789abcdef", {
      type: "canvas:updated",
      revision: 2,
      updatedAt,
    });
    expect(broadcastCanvasUpdate).toHaveBeenNthCalledWith(2, "cnv_0123456789abcdef", {
      type: "canvas:updated",
      revision: 3,
      updatedAt,
    });
    expect(broadcastCanvasUpdate).toHaveBeenNthCalledWith(3, "cnv_0123456789abcdef", {
      type: "canvas:deleted",
    });
  });

  it("uploads a canvas image asset after authentication and canvas validation", async () => {
    const uploadCanvasAsset = vi.fn().mockResolvedValue({
      assetId: "asset_0123456789abcdef",
      path: "system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png",
      mimeType: "image/png",
      sizeBytes: 8,
      originalName: "screenshot.png",
    });
    const app = createApp({ ...service, uploadCanvasAsset });
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("fake-png")], { type: "image/png" }), "screenshot.png");

    const res = await app.request("/api/canvases/cnv_0123456789abcdef/assets", {
      method: "POST",
      body: form,
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      path: "system/canvas-assets/cnv_0123456789abcdef/asset_0123456789abcdef.png",
      mimeType: "image/png",
    });
    expect(uploadCanvasAsset).toHaveBeenCalledWith("user_a", "cnv_0123456789abcdef", expect.any(File));
  });

  it("rejects unauthenticated canvas image uploads", async () => {
    const uploadCanvasAsset = vi.fn();
    const app = createApp({ ...service, uploadCanvasAsset }, null);
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("fake-png")], { type: "image/png" }), "screenshot.png");

    const res = await app.request("/api/canvases/cnv_0123456789abcdef/assets", {
      method: "POST",
      body: form,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(uploadCanvasAsset).not.toHaveBeenCalled();
  });

  it("rejects invalid canvas image upload requests before service calls", async () => {
    const uploadCanvasAsset = vi.fn();
    const app = createApp({ ...service, uploadCanvasAsset });

    const missingFile = await app.request("/api/canvases/cnv_0123456789abcdef/assets", {
      method: "POST",
      body: new FormData(),
    });
    expect(missingFile.status).toBe(400);
    expect(await missingFile.json()).toEqual({ error: "Invalid request" });

    const badType = new FormData();
    badType.append("file", new Blob([Buffer.from("<svg/>")], { type: "image/svg+xml" }), "bad.svg");
    const badTypeRes = await app.request("/api/canvases/cnv_0123456789abcdef/assets", {
      method: "POST",
      body: badType,
    });
    expect(badTypeRes.status).toBe(400);
    expect(await badTypeRes.json()).toEqual({ error: "Invalid request" });

    expect(uploadCanvasAsset).not.toHaveBeenCalled();
  });

  it("applies upload body limits before canvas image upload handling", async () => {
    const uploadCanvasAsset = vi.fn();
    const app = createApp({ ...service, uploadCanvasAsset });
    const form = new FormData();
    form.append("file", new Blob([Buffer.alloc(11 * 1024 * 1024)], { type: "image/png" }), "large.png");

    const res = await app.request("/api/canvases/cnv_0123456789abcdef/assets", {
      method: "POST",
      body: form,
    });

    expect(res.status).toBe(413);
    expect(uploadCanvasAsset).not.toHaveBeenCalled();
  });
});
