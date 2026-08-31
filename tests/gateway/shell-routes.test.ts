import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";

describe("retired terminal session routes", () => {
  const deps = {
    registry: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
    },
  };
  const app = new Hono()
    .route("/api", createShellRoutes(deps))
    .route("/api/terminal", createShellRoutes(deps));

  const retiredRequests: Array<{ path: string; method?: string; body?: string }> = [
    { path: "/api/sessions" },
    { path: "/api/sessions/main", method: "DELETE" },
    { path: "/api/terminal/sessions" },
    { path: "/api/terminal/sessions", method: "POST", body: JSON.stringify({ name: "legacy" }) },
    { path: "/api/terminal/sessions/main/rename", method: "PUT", body: JSON.stringify({ name: "other" }) },
    { path: "/api/terminal/sessions/main/ui-state", method: "PATCH", body: JSON.stringify({ placement: "active" }) },
    { path: "/api/terminal/sessions/main/paste-assets", method: "POST", body: "legacy" },
  ];

  for (const request of retiredRequests) {
    it(`returns 426 for ${request.method ?? "GET"} ${request.path}`, async () => {
      const response = await app.request(request.path, {
        method: request.method,
        body: request.body,
        headers: request.body ? { "content-type": "application/json" } : undefined,
      });

      expect(response.status).toBe(426);
      await expect(response.json()).resolves.toEqual({
        error: "client_upgrade_required",
        message: "Upgrade Matrix OS to use terminal workspaces.",
      });
    });
  }
});
