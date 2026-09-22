import { describe, expect, it, vi } from "vitest";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";

const runtimeId = "runtime_collaboration_owner";
const scopeId = "10000000-0000-4000-8000-000000000001";
const fencedScopeId = "10000000-0000-4000-8000-00000000000f";
const json = { headers: { "content-type": "application/json" }, body: "{}" };

function guard(overrides: { writable?: string[] } = {}) {
  const fenced = overrides.writable ?? [fencedScopeId];
  return {
    assertRuntimeWritable: vi.fn(async () => { throw new Error("maintenance"); }),
    assertWritable: vi.fn(async (id: string) => {
      if (fenced.includes(id)) throw new Error("maintenance");
    }),
  };
}

describe("S18 maintenance admission on owner HTTP routes", () => {
  it.each([
    ["POST", `/api/collaboration/runtimes/${runtimeId}/scopes`],
    ["POST", `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`],
    ["POST", `/api/collaboration/invitations/30000000-0000-4000-8000-000000000001/accept`],
  ])("rejects scopeless %s %s during a runtime cutover", async (method, path) => {
    const cutoverGuard = guard();
    const routes = createCollaborationRoutes({ runtimeId, cutoverGuard } as unknown as CollaborationRouteOptions);
    const response = await routes.request(path, { method, ...json });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(cutoverGuard.assertRuntimeWritable).toHaveBeenCalledExactlyOnceWith(runtimeId);
    expect(cutoverGuard.assertWritable).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", `/api/collaboration/scopes/${fencedScopeId}/lifecycle`],
    ["POST", `/api/collaboration/scopes/${fencedScopeId}/chat/requests`],
    ["PUT", `/api/collaboration/scopes/${fencedScopeId}/execution-policy`],
    ["DELETE", `/api/collaboration/scopes/${fencedScopeId}/invitations/30000000-0000-4000-8000-000000000001`],
  ])("rejects %s %s before owner route side effects while that scope is in maintenance", async (method, path) => {
    const cutoverGuard = guard();
    const routes = createCollaborationRoutes({ runtimeId, cutoverGuard } as unknown as CollaborationRouteOptions);
    const response = await routes.request(path, { method, ...json });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(cutoverGuard.assertWritable).toHaveBeenCalledExactlyOnceWith(fencedScopeId);
    expect(cutoverGuard.assertRuntimeWritable).not.toHaveBeenCalled();
  });

  it("keeps unrelated scopes writable while one scope of the same home is fenced", async () => {
    const cutoverGuard = guard();
    const routes = createCollaborationRoutes({ runtimeId, cutoverGuard } as unknown as CollaborationRouteOptions);
    expect((await routes.request(`/api/collaboration/scopes/${fencedScopeId}/lifecycle`, { method: "POST", ...json })).status).toBe(503);
    // The stub options make the handler itself fail, so the maintenance body is the discriminator.
    const unrelated = await routes.request(`/api/collaboration/scopes/${scopeId}/lifecycle`, { method: "POST", ...json });
    expect(await unrelated.json()).not.toMatchObject({ error: "Collaboration is unavailable" });
    expect(cutoverGuard.assertWritable.mock.calls).toEqual([[fencedScopeId], [scopeId]]);
    expect(cutoverGuard.assertRuntimeWritable).not.toHaveBeenCalled();
  });

  it("falls back to the runtime-wide gate when the path carries no scope identifier", async () => {
    const cutoverGuard = guard();
    const routes = createCollaborationRoutes({ runtimeId, cutoverGuard } as unknown as CollaborationRouteOptions);
    const response = await routes.request("/api/collaboration/scopes/not-a-scope-id/lifecycle", { method: "POST", ...json });
    expect(response.status).toBe(503);
    expect(cutoverGuard.assertRuntimeWritable).toHaveBeenCalledExactlyOnceWith(runtimeId);
    expect(cutoverGuard.assertWritable).not.toHaveBeenCalled();
  });

  it("allows read routes to reach their normal authentication path", async () => {
    const cutoverGuard = guard();
    const routes = createCollaborationRoutes({ runtimeId, cutoverGuard } as unknown as CollaborationRouteOptions);
    await routes.request(`/api/collaboration/scopes/${scopeId}`);
    expect(cutoverGuard.assertRuntimeWritable).not.toHaveBeenCalled();
    expect(cutoverGuard.assertWritable).not.toHaveBeenCalled();
  });
});
