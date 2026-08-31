import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import { createOsViewStateRoutes } from "../../packages/gateway/src/os-view-state/routes.js";
import { OsViewStateConflictError } from "../../packages/gateway/src/os-view-state/repository.js";

function appFor(repository: {
  getOrCreate: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
}, ownerId = "owner-1") {
  const app = new Hono();
  app.route("/api/os-view-state", createOsViewStateRoutes({ repository, getOwnerId: () => ownerId }));
  return app;
}

const record = {
  revision: 1,
  document: createDefaultOsViewDocument(),
  updatedAt: "2026-08-30T12:00:00.000Z",
};

describe("OS-view state routes", () => {
  it("loads the authenticated owner's document", async () => {
    const repository = { getOrCreate: vi.fn(async () => record), patch: vi.fn() };
    const response = await appFor(repository).request("/api/os-view-state");

    expect(response.status).toBe(200);
    expect(repository.getOrCreate).toHaveBeenCalledWith("owner-1");
    await expect(response.json()).resolves.toEqual(record);
  });

  it("validates a bounded mutation before writing", async () => {
    const repository = { getOrCreate: vi.fn(), patch: vi.fn() };
    const response = await appFor(repository).request("/api/os-view-state", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, mutationId: "bad", patch: {} }),
    });

    expect(response.status).toBe(400);
    expect(repository.patch).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Invalid OS-view state mutation" });
  });

  it("maps optimistic conflicts without leaking database details", async () => {
    const repository = {
      getOrCreate: vi.fn(),
      patch: vi.fn(async () => { throw new OsViewStateConflictError(7); }),
    };
    const response = await appFor(repository).request("/api/os-view-state", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseRevision: 1,
        mutationId: `osvm_${"a".repeat(32)}`,
        patch: { pinnedApps: ["__chat__"] },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "os_view_state_conflict", latestRevision: 7 });
  });

  it("requires a resolved owner", async () => {
    const repository = { getOrCreate: vi.fn(), patch: vi.fn() };
    const response = await appFor(repository, "").request("/api/os-view-state");
    expect(response.status).toBe(401);
  });
});
