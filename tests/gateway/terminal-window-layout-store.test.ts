import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";
import { createTerminalWindowLayoutRoutes } from "../../packages/gateway/src/shell/terminal-window-layout-routes.js";
import {
  TerminalLayoutRevisionConflictError,
  TerminalWindowLayoutStore,
} from "../../packages/gateway/src/shell/terminal-window-layout-store.js";

const FIRST_LAYOUT_ID = "term-layout_0123456789abcdef0123456789abcdef";
const SECOND_LAYOUT_ID = "term-layout_fedcba9876543210fedcba9876543210";

function layoutWithSession(sessionId: string) {
  return {
    tabs: [{
      id: `tab-${sessionId}`,
      label: sessionId,
      paneTree: {
        type: "pane" as const,
        id: `pane-${sessionId}`,
        cwd: "projects",
        sessionId,
      },
    }],
    activeTabId: `tab-${sessionId}`,
    sidebarOpen: true,
  };
}

describe("terminal window layout store", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-layouts-"));
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  it("keeps independent revisions for distinct Terminal windows", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });

    await expect(store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("alpha"))).resolves.toMatchObject({ revision: 1 });
    await expect(store.put(SECOND_LAYOUT_ID, 0, layoutWithSession("beta"))).resolves.toMatchObject({ revision: 1 });
    await expect(store.put(FIRST_LAYOUT_ID, 1, layoutWithSession("gamma"))).resolves.toMatchObject({ revision: 2 });

    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({
      revision: 2,
      layout: { tabs: [{ paneTree: { sessionId: "gamma" } }] },
    });
    await expect(store.get(SECOND_LAYOUT_ID)).resolves.toMatchObject({
      revision: 1,
      layout: { tabs: [{ paneTree: { sessionId: "beta" } }] },
    });
  });

  it("rejects stale writes without replacing the current layout", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });
    await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("alpha"));

    await expect(store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("stale"))).rejects.toBeInstanceOf(
      TerminalLayoutRevisionConflictError,
    );
    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({
      revision: 1,
      layout: { tabs: [{ paneTree: { sessionId: "alpha" } }] },
    });
  });

  it("tombstones a deleted session across every layout and rejects stale resurrection", async () => {
    const store = new TerminalWindowLayoutStore({
      homePath,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));
    await store.put(SECOND_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));

    await store.deleteSessionReferences("deleted-shell");

    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({ layout: { tabs: [] } });
    await expect(store.get(SECOND_LAYOUT_ID)).resolves.toMatchObject({ layout: { tabs: [] } });

    const staleWrite = await store.put(FIRST_LAYOUT_ID, 2, layoutWithSession("deleted-shell"));
    expect(staleWrite.layout.tabs).toEqual([]);
    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({ layout: { tabs: [] } });
  });

  it("allows explicit recovery to clear a deletion tombstone", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });
    await store.deleteSessionReferences("recover-me");
    await store.clearSessionTombstone("recover-me");

    const saved = await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("recover-me"));

    expect(saved.layout.tabs).toHaveLength(1);
    expect(saved.layout.tabs[0]?.paneTree).toMatchObject({ sessionId: "recover-me" });
  });

  it("deletes one shell through the gateway and reconciles every window layout", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });
    await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));
    await store.put(SECOND_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    const app = new Hono()
      .route("/api/terminal", createShellRoutes({ registry, sessionLifecycle: store }))
      .route(
        "/api/terminal/window-layouts",
        createTerminalWindowLayoutRoutes({ store }),
      );

    const deleted = await app.request("/api/terminal/sessions/deleted-shell?force=1", {
      method: "DELETE",
    });

    expect(deleted.status).toBe(200);
    expect(registry.delete).toHaveBeenCalledWith("deleted-shell", { force: true });
    for (const layoutId of [FIRST_LAYOUT_ID, SECOND_LAYOUT_ID]) {
      const restored = await app.request(`/api/terminal/window-layouts/${layoutId}`);
      await expect(restored.json()).resolves.toMatchObject({
        revision: 2,
        layout: { tabs: [] },
      });
    }
  });

  it("migrates the legacy global layout into exactly one stable window id", async () => {
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(
      join(homePath, "system", "terminal-layout.json"),
      JSON.stringify(layoutWithSession("legacy-shell")),
    );
    const store = new TerminalWindowLayoutStore({ homePath });

    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({
      revision: 1,
      layout: { tabs: [{ paneTree: { sessionId: "legacy-shell" } }] },
    });
    await expect(store.get(SECOND_LAYOUT_ID)).resolves.toMatchObject({
      revision: 0,
      layout: { tabs: [] },
    });
  });
});
