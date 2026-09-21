import { describe, expect, it, vi } from "vitest";
import { createCollaborationRoutes, type CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/routes.js";

const runtimeId = "runtime_collaboration_owner";
const scopeId = "10000000-0000-4000-8000-000000000001";

describe("S18 maintenance admission on owner HTTP routes", () => {
  it.each([
    ["POST", `/api/collaboration/runtimes/${runtimeId}/scopes`],
    ["POST", `/api/collaboration/runtimes/${runtimeId}/catalog/resolve`],
    ["POST", `/api/collaboration/scopes/${scopeId}/lifecycle`],
    ["POST", `/api/collaboration/invitations/30000000-0000-4000-8000-000000000001/accept`],
    ["POST", `/api/collaboration/scopes/${scopeId}/chat/requests`],
    ["PUT", `/api/collaboration/scopes/${scopeId}/execution-policy`],
    ["DELETE", `/api/collaboration/scopes/${scopeId}/invitations/30000000-0000-4000-8000-000000000001`],
  ])("rejects %s %s before owner route side effects during a runtime cutover", async (method, path) => {
    const assertRuntimeWritable = vi.fn(async () => { throw new Error("maintenance"); });
    const routes = createCollaborationRoutes({ runtimeId, cutoverGuard: { assertRuntimeWritable } } as unknown as CollaborationRouteOptions);
    const response = await routes.request(path, { method, headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
    expect(assertRuntimeWritable).toHaveBeenCalledExactlyOnceWith(runtimeId);
  });

  it("allows read routes to reach their normal authentication path", async () => {
    const assertRuntimeWritable = vi.fn(async () => { throw new Error("maintenance"); });
    const routes = createCollaborationRoutes({ runtimeId, cutoverGuard: { assertRuntimeWritable } } as unknown as CollaborationRouteOptions);
    await routes.request(`/api/collaboration/scopes/${scopeId}`);
    expect(assertRuntimeWritable).not.toHaveBeenCalled();
  });
});
