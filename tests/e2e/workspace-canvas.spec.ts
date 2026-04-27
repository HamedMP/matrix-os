import { test, expect } from "@playwright/test";

test.describe("workspace canvas smoke", () => {
  test("opens a seeded PR canvas and preserves terminal node identity", async ({ page }) => {
    await page.route("**/api/canvases", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { canvases: [{ id: "cnv_seed", title: "Seed PR", scopeType: "pull_request", scopeRef: {}, revision: 1, updatedAt: new Date().toISOString(), nodeCounts: { total: 1, stale: 0, live: 1 } }] } });
        return;
      }
      await route.fallback();
    });
    await page.route("**/api/canvases/cnv_seed", async (route) => {
      await route.fulfill({ json: { document: { id: "cnv_seed", title: "Seed PR", revision: 1, schemaVersion: 1, scopeType: "pull_request", scopeRef: {}, nodes: [{ id: "node_terminal", type: "terminal", position: { x: 100, y: 100 }, size: { width: 320, height: 180 }, zIndex: 0, displayState: "normal", sourceRef: { kind: "terminal_session", id: "550e8400-e29b-41d4-a716-446655440000" }, metadata: { label: "Terminal" } }], edges: [], viewStates: [], displayOptions: {} }, linkedState: {} } });
    });

    await page.goto("/");
    await expect(page.locator("[data-tldraw-workspace]")).toBeVisible({ timeout: 30_000 });
  });
});
