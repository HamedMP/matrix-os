import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createChatDriveToolRoutes } from "../../packages/gateway/src/chat/drive-context-routes.js";
const owner = { type: "personal", ownerId: "user_owner" };
function fixture() { const registry = createMatrixMcpCapabilityRegistry({ configuredOwnerId: owner.ownerId }); const capability = registry.issue({ owner, runId: "run_selected", scope: "discovery", driveContext: true })!; const search = vi.fn(async () => ({ files: [] })); const read = vi.fn(async () => ({ status: "unsupported" })); const app = new Hono(); app.use("*", authMiddleware("machine-secret", { resolveMatrixMcpRunContext: registry.resolveRunContext })); app.route("/", createChatDriveToolRoutes({ service: { search, read } as never })); return { app, registry, capability, search, read }; }
describe("run-scoped company drive tool routes", () => {
    it("derives owner and run from the scoped bearer, ignoring forged headers", async () => { const f = fixture(); try {
        const response = await f.app.request("/api/chat-drive-context/search", { method: "POST", headers: { authorization: `Bearer ${f.capability.token}`, "content-type": "application/json", "x-matrix-mcp-run-id": "run_forged" }, body: JSON.stringify({ referenceIndex: 0, query: "plan" }) });
        expect(response.status).toBe(200);
        expect(f.search).toHaveBeenCalledWith(owner.ownerId, "run_selected", expect.objectContaining({ referenceIndex: 0, query: "plan" }), expect.any(AbortSignal));
        expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    finally {
        f.registry.close();
    } });
    it("rejects ordinary machine authentication and input authority overrides", async () => { const f = fixture(); try {
        for (const body of [{ referenceIndex: 0, ownerId: "other" }, { referenceIndex: 0, runId: "run_other" }, { referenceIndex: 0, scopeId: "forged" }])
            expect((await f.app.request("/api/chat-drive-context/search", { method: "POST", headers: { authorization: `Bearer ${f.capability.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(422);
        expect((await f.app.request("/api/chat-drive-context/read", { method: "POST", headers: { authorization: "Bearer machine-secret", "content-type": "application/json" }, body: JSON.stringify({ referenceIndex: 0 }) })).status).toBe(403);
        expect(f.search).not.toHaveBeenCalled();
        expect(f.read).not.toHaveBeenCalled();
    }
    finally {
        f.registry.close();
    } });
    it("revokes read authority with the capability and denies other APIs", async () => { const f = fixture(); try {
        const headers = { authorization: `Bearer ${f.capability.token}`, "content-type": "application/json" };
        expect((await f.app.request("/api/files", { headers })).status).toBe(401);
        f.capability.revoke();
        expect((await f.app.request("/api/chat-drive-context/read", { method: "POST", headers, body: '{"referenceIndex":0}' })).status).toBe(401);
    }
    finally {
        f.registry.close();
    } });
});
