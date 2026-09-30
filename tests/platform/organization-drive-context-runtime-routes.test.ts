import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createPlatformDriveContextRuntimeRoutes } from "../../packages/platform/src/collaboration/drive-context-routes.js";
const scopeId = "00000000-0000-4000-8000-000000000001";
const base = "/internal/collaboration/drive-context";
const headers = { "x-matrix-collaboration-runtime": "runtime_owner", "x-matrix-runtime-id": "vps:owner", authorization: `Bearer ${"a".repeat(32)}`, "content-type": "application/json" };
function fixture() { const authenticateRuntime = vi.fn().mockResolvedValue({ runtimeId: "vps:owner", ownerId: "user_owner" }); const issue = vi.fn().mockResolvedValue({ signedTicket: { ticket: { resource: { kind: "folder" } } }, endpoint: { origin: "https://app.example" } }); const forward = vi.fn().mockResolvedValue(new Response('{"files":[]}', { headers: { "content-type": "application/json" } })); const app = new Hono().route("/", createPlatformDriveContextRuntimeRoutes({ issuer: { issue } as never, relay: { forward } as never, authenticateRuntime, relayOrigin: "https://app.example" })); return { app, authenticateRuntime, issue, forward }; }
describe("headless owner-runtime drive context routes", () => {
    it("derives the actor from enrollment and issues only a bounded scope session", async () => {
        const f = fixture();
        const response = await f.app.request(`${base}/connections`, { method: "POST", headers, body: JSON.stringify({ scopeId, clientRequestId: scopeId, proofPublicKey: "a".repeat(43) }) });
        expect(response.status).toBe(201);
        expect(f.issue).toHaveBeenCalledWith({ actorId: "user_owner", request: { scopeId, clientRequestId: scopeId, proofPublicKey: "a".repeat(43), purpose: "direct_session", maxActions: 4 } });
    });
    it("cannot choose another actor or request a Terminal ticket", async () => {
        const f = fixture();
        for (const extra of [{ actorId: "user_other" }, { purpose: "terminal" }, { maxActions: 1000 }]) {
            expect((await f.app.request(`${base}/connections`, { method: "POST", headers, body: JSON.stringify({ scopeId, clientRequestId: scopeId, proofPublicKey: "a".repeat(43), ...extra }) })).status).toBe(422);
        }
        expect(f.issue).not.toHaveBeenCalled();
    });
    it("requires current enrolled runtime authentication on every read", async () => {
        const f = fixture();
        f.authenticateRuntime.mockResolvedValue(null);
        expect((await f.app.request(`${base}/relay/api/collaboration/scopes/${scopeId}/drive/context/search`, { headers })).status).toBe(401);
        expect(f.forward).not.toHaveBeenCalled();
    });
    it("forwards only the read context path with the enrolled actor", async () => {
        const f = fixture();
        const response = await f.app.request(`${base}/relay/api/collaboration/scopes/${scopeId}/drive/context/search`, { method: "POST", headers, body: JSON.stringify({ query: "plan" }) });
        expect(response.status).toBe(200);
        expect(f.forward.mock.calls[0][0]).toMatchObject({ body: expect.any(Uint8Array), actorId: "user_owner", method: "POST", path: `/api/collaboration/scopes/${scopeId}/drive/context/search`, query: "" });
    });
    it.each([["GET", "/api/collaboration/scopes/00000000-0000-4000-8000-000000000001/drive"], ["POST", "/api/collaboration/scopes/00000000-0000-4000-8000-000000000001/drive/uploads"], ["DELETE", "/api/collaboration/scopes/00000000-0000-4000-8000-000000000001"], ["GET", "/api/files"]])("does not expose arbitrary %s %s", async (method, path) => {
        const f = fixture();
        expect((await f.app.request(`${base}/relay${path}`, { method, headers })).status).toBe(404);
        expect(f.forward).not.toHaveBeenCalled();
    });
    it("applies a body limit before buffering session exchange", async () => {
        const f = fixture();
        expect((await f.app.request(`${base}/relay/api/collaboration/direct-sessions`, { method: "POST", headers, body: " ".repeat(100 * 1024) })).status).toBe(413);
        expect(f.forward).not.toHaveBeenCalled();
    });
 it.each(["version=0","version=-1","version=2147483648","version=2&version=3","other=2"])("rejects an invalid signed read query %s before relay",async query=>{const f=fixture();const response=await f.app.request(`${base}/relay/api/collaboration/scopes/${scopeId}/drive/files/${scopeId}/context?${query}`,{headers});expect(response.status).toBe(422);expect(f.forward).not.toHaveBeenCalled();});
 it("preserves the original validated read query bytes",async()=>{const f=fixture();const response=await f.app.request(`${base}/relay/api/collaboration/scopes/${scopeId}/drive/files/${scopeId}/context?version=2`,{headers});expect(response.status).toBe(200);expect(f.forward.mock.calls[0][0]).toMatchObject({query:"version=2"});});

});
