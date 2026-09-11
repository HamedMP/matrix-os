import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createTerminalWindowLayoutRoutes } from "../../packages/gateway/src/shell/terminal-window-layout-routes.js";
import { TerminalLayoutRevisionConflictError } from "../../packages/gateway/src/shell/terminal-window-layout-store.js";

const LAYOUT_ID = "term-layout_0123456789abcdef0123456789abcdef";
const EMPTY_LAYOUT = { tabs: [], activeTabId: "", sidebarOpen: true };

describe("terminal window layout routes", () => {
  it("reads, revision-writes, and deletes one validated layout id", async () => {
    const store = {
      get: vi.fn(async () => ({ layoutId: LAYOUT_ID, revision: 0, layout: EMPTY_LAYOUT })),
      put: vi.fn(async () => ({ layoutId: LAYOUT_ID, revision: 1, layout: EMPTY_LAYOUT })),
      deleteLayout: vi.fn(async () => undefined),
    };
    const app = new Hono().route("/api/terminal/window-layouts", createTerminalWindowLayoutRoutes({ store }));

    expect((await app.request(`/api/terminal/window-layouts/${LAYOUT_ID}`)).status).toBe(200);
    const saved = await app.request(`/api/terminal/window-layouts/${LAYOUT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, layout: EMPTY_LAYOUT }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ revision: 1 });
    expect((await app.request(`/api/terminal/window-layouts/${LAYOUT_ID}`, { method: "DELETE" })).status).toBe(200);

    expect(store.put).toHaveBeenCalledWith(LAYOUT_ID, 0, EMPTY_LAYOUT);
    expect(store.deleteLayout).toHaveBeenCalledWith(LAYOUT_ID);
  });

  it("maps revision conflicts to one generic stable response", async () => {
    const store = {
      get: vi.fn(),
      put: vi.fn(async () => { throw new TerminalLayoutRevisionConflictError(); }),
      deleteLayout: vi.fn(),
    };
    const app = new Hono().route("/api/terminal/window-layouts", createTerminalWindowLayoutRoutes({ store }));

    const res = await app.request(`/api/terminal/window-layouts/${LAYOUT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, layout: EMPTY_LAYOUT }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: { code: "layout_revision_conflict", message: "Layout changed elsewhere" },
    });
  });

  it("rejects invalid ids, schemas, and oversized delete bodies before storage", async () => {
    const store = { get: vi.fn(), put: vi.fn(), deleteLayout: vi.fn() };
    const app = new Hono().route("/api/terminal/window-layouts", createTerminalWindowLayoutRoutes({ store }));

    expect((await app.request("/api/terminal/window-layouts/../../unsafe")).status).toBe(404);
    expect((await app.request(`/api/terminal/window-layouts/${LAYOUT_ID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: -1, layout: EMPTY_LAYOUT }),
    })).status).toBe(400);
    expect((await app.request(`/api/terminal/window-layouts/${LAYOUT_ID}`, {
      method: "DELETE",
      headers: { "Content-Length": "1024" },
      body: "x".repeat(1024),
    })).status).toBe(413);
    expect(store.put).not.toHaveBeenCalled();
    expect(store.deleteLayout).not.toHaveBeenCalled();
  });
});
