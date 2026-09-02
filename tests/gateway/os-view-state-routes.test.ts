import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDefaultOsViewDocument } from "@matrix-os/contracts";
import { createOsViewStateRoutes } from "../../packages/gateway/src/os-view-state/routes.js";
import { OsViewStateConflictError } from "../../packages/gateway/src/os-view-state/repository.js";

function appFor(repository: {
  getOrCreate: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  importLegacyDesktop: ReturnType<typeof vi.fn>;
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
    const repository = { getOrCreate: vi.fn(async () => record), patch: vi.fn(), importLegacyDesktop: vi.fn() };
    const response = await appFor(repository).request("/api/os-view-state");

    expect(response.status).toBe(200);
    expect(repository.getOrCreate).toHaveBeenCalledWith("owner-1");
    await expect(response.json()).resolves.toEqual(record);
  });

  it("validates a bounded mutation before writing", async () => {
    const repository = { getOrCreate: vi.fn(), patch: vi.fn(), importLegacyDesktop: vi.fn() };
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
      importLegacyDesktop: vi.fn(),
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
    const repository = { getOrCreate: vi.fn(), patch: vi.fn(), importLegacyDesktop: vi.fn() };
    const response = await appFor(repository, "").request("/api/os-view-state");
    expect(response.status).toBe(401);
  });

  it("imports bounded legacy Desktop fields for the authenticated owner", async () => {
    const repository = {
      getOrCreate: vi.fn(),
      patch: vi.fn(),
      importLegacyDesktop: vi.fn(async () => record),
    };
    const response = await appFor(repository).request("/api/os-view-state/import-legacy-desktop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinnedApps: ["__chat__"] }),
    });

    expect(response.status).toBe(200);
    expect(repository.importLegacyDesktop).toHaveBeenCalledWith("owner-1", { pinnedApps: ["__chat__"] });
    await expect(response.json()).resolves.toEqual(record);
  });

  it("marks a legacy Desktop source with no layout fields as imported", async () => {
    const repository = {
      getOrCreate: vi.fn(),
      patch: vi.fn(),
      importLegacyDesktop: vi.fn(async () => record),
    };
    const response = await appFor(repository).request("/api/os-view-state/import-legacy-desktop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(repository.importLegacyDesktop).toHaveBeenCalledWith("owner-1", {});
  });

  it("rejects invalid legacy imports before writing", async () => {
    const repository = { getOrCreate: vi.fn(), patch: vi.fn(), importLegacyDesktop: vi.fn() };
    const response = await appFor(repository).request("/api/os-view-state/import-legacy-desktop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desktopIcons: [{ path: "", x: -1, y: 0 }] }),
    });

    expect(response.status).toBe(400);
    expect(repository.importLegacyDesktop).not.toHaveBeenCalled();
  });

  it("requires an owner and applies the import body limit", async () => {
    const repository = { getOrCreate: vi.fn(), patch: vi.fn(), importLegacyDesktop: vi.fn() };
    const unauthorized = await appFor(repository, "").request("/api/os-view-state/import-legacy-desktop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const oversized = await appFor(repository).request("/api/os-view-state/import-legacy-desktop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinnedApps: ["a".repeat(256 * 1024)] }),
    });

    expect(unauthorized.status).toBe(401);
    expect(oversized.status).toBe(413);
    expect(repository.importLegacyDesktop).not.toHaveBeenCalled();
  });
});
