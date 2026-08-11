import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createTrashService() {
  return {
    trash: vi.fn(),
    delete: vi.fn().mockResolvedValue({ ok: true, trashPath: ".trash/a.md" }),
    list: vi.fn().mockResolvedValue({ entries: [] }),
    restore: vi.fn().mockResolvedValue({ ok: true, restoredTo: "projects/a.md" }),
    empty: vi.fn().mockResolvedValue({ ok: true, deleted: 1 }),
    close: vi.fn(),
  };
}

function createApp() {
  const app = new Hono();
  const trashService = createTrashService();
  registerFileRoutes(app, { homePath: "/owner/home", trashService });
  return { app, trashService };
}

describe("legacy Trash HTTP boundary", () => {
  it.each([
    ["/api/files/delete", { path: "projects/a.md", extra: true }, "delete"],
    ["/api/files/trash/restore", { trashPath: ".trash/a.md", extra: true }, "restore"],
  ] as const)("rejects unknown fields for %s", async (path, body, method) => {
    const { app, trashService } = createApp();

    const response = await app.request(jsonRequest(path, body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request" });
    expect(trashService[method]).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/files/delete", "delete"],
    ["/api/files/trash/restore", "restore"],
    ["/api/files/trash/empty", "empty"],
  ] as const)("rejects malformed JSON for %s without mutation", async (path, method) => {
    const { app, trashService } = createApp();

    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request" });
    expect(trashService[method]).not.toHaveBeenCalled();
  });

  it("accepts absent, zero-length, and strict empty-object bodies for empty Trash", async () => {
    const { app, trashService } = createApp();

    const absent = await app.request("/api/files/trash/empty", { method: "POST" });
    const zeroLength = await app.request("/api/files/trash/empty", { method: "POST", body: "" });
    const emptyObject = await app.request(jsonRequest("/api/files/trash/empty", {}));
    const unknown = await app.request(jsonRequest("/api/files/trash/empty", { force: true }));

    expect([absent.status, zeroLength.status, emptyObject.status]).toEqual([200, 200, 200]);
    expect(unknown.status).toBe(400);
    expect(trashService.empty).toHaveBeenCalledTimes(3);
  });

  it("rejects a streamed oversized empty request before destructive execution", async () => {
    const { app, trashService } = createApp();
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 129; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/files/trash/empty", {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(trashService.empty).not.toHaveBeenCalled();
  });
});
