import { describe, expect, it, vi } from "vitest";
import { createAppReadJobRoutes } from "../../../packages/gateway/src/app-read-jobs/routes.js";

describe("owner app read job routes", () => {
  const state = { generation: 1, paused: false, status: "running", nextDueAt: "2026-10-07 01:00:00+00", lastAttemptAt: null, lastSuccessAt: null, leaseUntil: null, summaryAt: null, summaryHash: null };
  const fixture = (userId = "owner") => {
    const runner = { configure: vi.fn(async () => ({ ...state, configuration: { enabled: true, intervalMs: 900000, summary: null } })), status: vi.fn(async () => state), run: vi.fn(async () => ({ status: "accepted" })), pause: vi.fn(async () => ({ ...state, paused: true })) };
    return { runner, app: createAppReadJobRoutes({ ownerIds: ["owner"], runner: runner as never, getPrincipal: () => ({ userId }) }) };
  };
  const post = (app: ReturnType<typeof fixture>["app"], path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  it("uses the server principal and returns only safe status metadata", async () => {
    const { app, runner } = fixture();
    expect(await (await post(app, "/status", { app: "briefing", jobId: "daily" })).json()).toEqual({ jobId: "daily", state: { ...state, nextDueAt: "2026-10-07T01:00:00.000Z" } });
    expect(runner.status).toHaveBeenCalledWith("owner", "briefing", "daily");
    expect(await (await post(app, "/run", { app: "briefing", jobId: "daily" })).json()).toEqual({ status: "accepted" });
    expect(runner.run).toHaveBeenCalledWith("owner", "briefing", "daily");
    expect((await post(app, "/pause", { app: "briefing", jobId: "daily", paused: true })).status).toBe(200);
    expect(runner.pause).toHaveBeenCalledWith("owner", "briefing", "daily", true);
    const configured = await post(app, "/configure", { app: "briefing", jobId: "daily", settings: { intervalMs: 1800000 } });
    expect(configured.status).toBe(200);
    expect(runner.configure).toHaveBeenCalledWith("owner", "briefing", "daily", { intervalMs: 1800000 });
    expect((await configured.json()).state.configuration).toEqual({ enabled: true, intervalMs: 900000, summary: null });
  });
  it("denies a foreign owner and extra fields before runner invocation", async () => {
    const { app, runner } = fixture("foreign");
    expect((await post(app, "/status", { app: "briefing", jobId: "daily" })).status).toBe(403);
    expect((await post(app, "/run", { app: "briefing", jobId: "daily", ownerId: "owner" })).status).toBe(400);
    expect((await post(app, "/pause", { app: "briefing", jobId: "daily", paused: "true" })).status).toBe(400);
    for (const settings of [{}, { intervalMs: 1000 }, { sources: [] }, { enabled: true, grants: ["github"] }, { summary: { enabled: true, timezone: "invalid" } }]) {
      expect((await post(app, "/configure", { app: "briefing", jobId: "daily", settings })).status).toBe(400);
    }
    expect(runner.configure).not.toHaveBeenCalled();
    expect(runner.status).not.toHaveBeenCalled(); expect(runner.run).not.toHaveBeenCalled(); expect(runner.pause).not.toHaveBeenCalled();
  });
  it("checks body limits on every action and does not expose unexpected runner errors", async () => {
    const { app, runner } = fixture();
    for (const path of ["/status", "/run", "/pause", "/configure"]) {
      expect((await post(app, path, { app: "briefing", jobId: "a".repeat(10_000) })).status).toBe(413);
    }
    runner.run.mockRejectedValueOnce(new Error("private database credential"));
    const response = await post(app, "/run", { app: "briefing", jobId: "daily" });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private database");
    runner.status.mockResolvedValueOnce({ ...state, sourceData: "private feedback" } as never);
    const malformed = await post(app, "/status", { app: "briefing", jobId: "daily" });
    expect(malformed.status).toBe(503); expect(await malformed.text()).not.toContain("private feedback");
  });
});
