import { describe, expect, it, vi } from "vitest";
import { createMemoryWorkspaceRoutes } from "../../packages/gateway/src/memory-workspace/routes.js";
import { MemoryWorkspaceService } from "../../packages/gateway/src/memory-workspace/service.js";
const repo = {
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
describe("memory routes", () => {
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
