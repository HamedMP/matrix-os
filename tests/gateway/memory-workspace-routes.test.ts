import { describe, expect, it, vi } from "vitest";
import { createMemoryWorkspaceRoutes } from "../../packages/gateway/src/memory-workspace/routes.js";
import { MemoryWorkspaceService } from "../../packages/gateway/src/memory-workspace/service.js";
const repo = {
  revalidateSearch: vi.fn(
    async (
      _owner: string,
      results: import("@matrix-os/contracts").MemorySearchResult[],
    ) => results,
  ),
  listSources: vi.fn(async () => []),
  getSource: vi.fn(async () => null),
  listJobs: vi.fn(async () => []),
  importSources: vi.fn(),
  recordComparison: vi.fn(async () => {}),
};
const make = (owner = "alice") =>
  createMemoryWorkspaceRoutes({
    service: new MemoryWorkspaceService(repo, {}),
    getOwnerId: () => owner,
  });
const jobId = "00000000-0000-4000-8000-000000000001";
function jobRoutes(owner = "alice") {
  const service = new MemoryWorkspaceService(repo, {});
  const action = vi.spyOn(service, "jobAction").mockResolvedValue(true);
  return { action, app: createMemoryWorkspaceRoutes({ service, getOwnerId: () => owner }) };
}
const jobRequest = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
describe("memory routes", () => {
  it.each(["retry", "cancel"] as const)("admits strict %s job actions for the authenticated owner", async (type) => {
    const { app, action } = jobRoutes();
    const response = await app.request(`/jobs/${jobId}/action`, jobRequest({ type }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: true });
    expect(action).toHaveBeenCalledExactlyOnceWith("alice", jobId, type);
  });
  it.each([
    { action: "retry" },
    { type: "unknown" },
    {},
    { type: "retry", sourceId: jobId },
    { type: "cancel", action: "retry" },
    { type: "cancel", payload: {} },
  ])("rejects invalid job payload %j before mutation", async (body) => {
    const { app, action } = jobRoutes();
    const response = await app.request(`/jobs/${jobId}/action`, jobRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid memory request" });
    expect(action).not.toHaveBeenCalled();
  });
  it("retains owner, UUID and streaming body protection for job actions", async () => {
    const unauthenticated = jobRoutes("");
    expect((await unauthenticated.app.request(`/jobs/${jobId}/action`, jobRequest({ type: "retry" }))).status).toBe(401);
    expect(unauthenticated.action).not.toHaveBeenCalled();
    const { app, action } = jobRoutes();
    expect((await app.request("/jobs/invalid/action", jobRequest({ type: "retry" }))).status).toBe(400);
    expect((await app.request(`/jobs/${jobId}/action`, { method: "POST", body: "x".repeat(5000001) })).status).toBe(413);
    expect(action).not.toHaveBeenCalled();
  });
  it("retains conflict semantics when the job cannot be acted on", async () => {
    const { app, action } = jobRoutes();
    action.mockResolvedValue(false);
    const response = await app.request(`/jobs/${jobId}/action`, jobRequest({ type: "cancel" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Activity cannot be changed right now" });
  });
  it("requires authenticated owner and rejects malformed source IDs", async () => {
    expect((await make("").request("/")).status).toBe(401);
    expect((await make().request("/sources/not-a-uuid")).status).toBe(400);
    expect(
      (await make().request("/sources/00000000-0000-4000-8000-000000000001"))
        .status,
    ).toBe(404);
  });
  it("validates strict import bodies and enforces streaming body limits", async () => {
    const app = make();
    expect(
      (await app.request("/sources", { method: "POST", body: "{" })).status,
    ).toBe(400);
    expect(
      (
        await app.request("/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "question",
            engine: "hindsight",
            url: "http://evil",
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/sources/x", {
          method: "DELETE",
          body: "x".repeat(5000001),
        })
      ).status,
    ).toBe(413);
  });
  it("truthfully returns disconnected engine results and hides internal errors", async () => {
    const response = await make().request("/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "question" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).results[0].status).toBe("not_configured");
    repo.listSources.mockRejectedValueOnce(new Error("postgres private path"));
    const failed = await make().request("/");
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("postgres");
  });
});
