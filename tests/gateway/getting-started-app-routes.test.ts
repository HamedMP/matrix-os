import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createGettingStartedAppRoutes } from "../../packages/gateway/src/getting-started-app/routes.js";

function repositoryMock() {
  return {
    progress: vi.fn(async () => ({ awards: [], total: 0 })),
    award: vi.fn(async () => ({ awarded: true, points: 20, total: 20 })),
    claimAutoOpen: vi.fn(async () => true),
    desktopIconPlaced: vi.fn(async () => false),
    markDesktopIconPlaced: vi.fn(async () => undefined),
  };
}

function appFor(
  repository: ReturnType<typeof repositoryMock> | null,
  options: { ownerId?: string | null } = {},
) {
  const app = new Hono();
  app.route("/api/getting-started", createGettingStartedAppRoutes({
    repository,
    getOwnerId: () => (options.ownerId === undefined ? "owner-1" : options.ownerId),
  }));
  return app;
}

function post(app: Hono, path: string, body: unknown) {
  return app.request(`/api/getting-started${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("Getting started app routes", () => {
  it("returns the owner's progress", async () => {
    const repository = repositoryMock();
    const response = await appFor(repository).request("/api/getting-started/progress");
    expect(response.status).toBe(200);
    expect(repository.progress).toHaveBeenCalledWith("owner-1");
    await expect(response.json()).resolves.toEqual({ awards: [], total: 0 });
  });

  it("awards a valid task for the signed-in owner", async () => {
    const repository = repositoryMock();
    const response = await post(appFor(repository), "/awards", { taskId: "slack", silent: false });
    expect(response.status).toBe(200);
    expect(repository.award).toHaveBeenCalledWith("owner-1", "slack", false);
    await expect(response.json()).resolves.toEqual({ awarded: true, points: 20, total: 20 });
  });

  it("rejects unknown tasks, client-sent points and bad JSON without writing", async () => {
    const repository = repositoryMock();
    const app = appFor(repository);
    for (const body of [
      { taskId: "unknown", silent: false },
      { taskId: "invite-friends", silent: false },
      { taskId: "slack", silent: false, points: 1000 },
      "{not json",
    ]) {
      const response = await post(app, "/awards", body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid Getting started request" });
    }
    expect(repository.award).not.toHaveBeenCalled();
  });

  it("limits the award body size", async () => {
    const repository = repositoryMock();
    const response = await post(appFor(repository), "/awards", { taskId: "slack", silent: false, pad: "x".repeat(4096) });
    expect(response.status).toBe(413);
    expect(repository.award).not.toHaveBeenCalled();
  });

  it("claims the automatic first open", async () => {
    const repository = repositoryMock();
    const response = await post(appFor(repository), "/auto-open", {});
    expect(response.status).toBe(200);
    expect(repository.claimAutoOpen).toHaveBeenCalledWith("owner-1");
    await expect(response.json()).resolves.toEqual({ open: true });
  });

  it("reports whether the desktop icon was ever placed", async () => {
    const repository = repositoryMock();
    const response = await appFor(repository).request("/api/getting-started/desktop-icon");
    expect(response.status).toBe(200);
    expect(repository.desktopIconPlaced).toHaveBeenCalledWith("owner-1");
    await expect(response.json()).resolves.toEqual({ placed: false });
  });

  it("marks the desktop icon placed after a surface saved it", async () => {
    const repository = repositoryMock();
    const response = await post(appFor(repository), "/desktop-icon", {});
    expect(response.status).toBe(200);
    expect(repository.markDesktopIconPlaced).toHaveBeenCalledWith("owner-1");
    await expect(response.json()).resolves.toEqual({ placed: true });
  });

  it("rejects a desktop-icon body with fields", async () => {
    const repository = repositoryMock();
    const response = await post(appFor(repository), "/desktop-icon", { path: "elsewhere" });
    expect(response.status).toBe(400);
    expect(repository.markDesktopIconPlaced).not.toHaveBeenCalled();
  });

  it("rejects an auto-open body with fields", async () => {
    const repository = repositoryMock();
    const response = await post(appFor(repository), "/auto-open", { force: true });
    expect(response.status).toBe(400);
    expect(repository.claimAutoOpen).not.toHaveBeenCalled();
  });

  it("returns 401 without an owner", async () => {
    const repository = repositoryMock();
    const response = await appFor(repository, { ownerId: null }).request("/api/getting-started/progress");
    expect(response.status).toBe(401);
    expect(repository.progress).not.toHaveBeenCalled();
  });

  it("returns 503 when the owner database is not configured", async () => {
    const response = await appFor(null).request("/api/getting-started/progress");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Getting started is unavailable" });
  });

  it("hides database errors behind a generic message", async () => {
    const repository = repositoryMock();
    const cause = new Error('relation "getting_started_awards" does not exist');
    repository.award.mockRejectedValueOnce(cause);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await post(appFor(repository), "/awards", { taskId: "slack", silent: false });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "Getting started is unavailable" });
    expect(JSON.stringify(body)).not.toContain("relation");
    expect(error).toHaveBeenCalledWith("[getting-started-app] Request failed:", cause);
    error.mockRestore();
  });
});
