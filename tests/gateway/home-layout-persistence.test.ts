import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHomeUtilityRoutes } from "../../packages/gateway/src/server/home-utility-routes.js";

// Route/storage integration: real registrar and owner files, without gateway auth or UI.
describe("owner layout route persistence", () => {
  let homePath: string;
  beforeEach(async () => { homePath = await mkdtemp(join(tmpdir(), "home-layout-persistence-")); });
  afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

  function mountedRoutes() {
    const app = new Hono();
    const unrelated = new Proxy({}, {
      get(_target, key) { throw new Error(`Layout request accessed unrelated dependency: ${String(key)}`); },
    }) as never;
    registerHomeUtilityRoutes({
      app, homePath, conversations: unrelated, canvasService: null, dispatcher: unrelated,
      cronService: unrelated, channelManager: unrelated, interactionLogger: unrelated,
      broadcast() { throw new Error("Layout request unexpectedly broadcast"); },
      logBestEffortFailure(_context, error) { throw error; },
    });
    return app;
  }

  function save(app: Hono, layout: unknown) {
    return app.request("/api/layout", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(layout),
    });
  }

  const layout = {
    windows: [
      { id: "notes", path: "apps/notes", title: "Notes λ", x: 31, y: 42, width: 640, height: 480, state: "open" },
      { id: "files", path: "__files__", title: "Files", x: 0, y: 0, width: 800, height: 600, state: "minimized" },
    ],
    dock: [{ path: "apps/notes", pinned: true }],
    activeWindowId: "notes",
  };

  it("persists the exact submitted layout for a freshly registered app reading the same home", async () => {
    const response = await save(mountedRoutes(), layout);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const rehydrated = await mountedRoutes().request("/api/layout");
    expect(rehydrated.status).toBe(200);
    expect(await rehydrated.json()).toEqual(layout);
    expect(JSON.parse(await readFile(join(homePath, "system/layout.json"), "utf8"))).toEqual(layout);
  });

  it.each([null, {}, { windows: {} }, { windows: "invalid" }])(
    "rejects invalid layout %j without replacing the saved owner state", async invalid => {
      const app = mountedRoutes();
      expect((await save(app, layout)).status).toBe(200);
      const savedBytes = await readFile(join(homePath, "system/layout.json"), "utf8");

      expect((await save(app, invalid)).status).toBe(400);

      expect(await readFile(join(homePath, "system/layout.json"), "utf8")).toBe(savedBytes);
      const response = await mountedRoutes().request("/api/layout");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(layout);
    },
  );

  it("returns an empty layout for a new owner home with no saved layout", async () => {
    const response = await mountedRoutes().request("/api/layout");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  });
});
