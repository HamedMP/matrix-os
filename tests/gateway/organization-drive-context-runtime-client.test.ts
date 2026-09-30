import { describe, expect, it, vi } from "vitest";
import { createDriveContextRuntimeClient } from "../../packages/gateway/src/organization-drive/context-runtime-client.js";
import { proofKeyThumbprint, requestSigningPayload, sha256Hex, verifyEd25519 } from "../../packages/gateway/src/collaboration/direct-crypto.js";
const scopeId = "00000000-0000-4000-8000-000000000001";
const fileId = "00000000-0000-4000-8000-000000000002";
const ref = { kind: "drive" as const, scopeId, organizationId: "org_example" };
function fixture() {
    let key = "";
    const paths: string[] = [];
    let actor = "user_owner";
    let path = "reports/plan.md";
    let origin = "https://app.example";
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        paths.push(u.pathname);
        const headers = new Headers(init?.headers);
        expect(headers.get("x-matrix-runtime-id")).toBe("vps:requester");
        expect(headers.get("authorization")).toBe(`Bearer ${"a".repeat(32)}`);
        expect(init?.redirect).toBe("error");
        expect(init?.signal).toBeTruthy();
        const now = new Date();
        const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
        const session = { protocolVersion: 2, id: fileId, actorId: actor, organizationId: ref.organizationId, scopeId, runtimeId: "runtime_authority", authorityGeneration: 1, purpose: "direct_session", proofKeyThumbprint: proofKeyThumbprint(key || "a".repeat(43)), issuedAt: at(0), expiresAt: at(300000), evidenceExpiresAt: at(20000), renewAfter: at(10000) };
        if (u.pathname.endsWith("/connections")) {
            const body = JSON.parse(init!.body as string);
            key = body.proofPublicKey;
            return Response.json({ signedTicket: { keyId: "key_one", signature: "a".repeat(86), ticket: { protocolVersion: 2, ticketId: fileId, nonce: "a".repeat(32), actorId: actor, organizationId: ref.organizationId, resource: { scopeId, kind: "folder" }, purpose: "direct_session", runtime: { runtimeId: "runtime_authority", authorityGeneration: 1 }, proofKeyThumbprint: proofKeyThumbprint(key), maxActions: 4, issuedAt: at(0), expiresAt: at(30000) } }, endpoint: { origin, protocolVersion: 2 } });
        }
        if (u.pathname.endsWith("/direct-sessions") && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            expect(body.proofPublicKey).toBe(key);
            return Response.json(session);
        }
        const signed = JSON.parse(Buffer.from(headers.get("x-matrix-collaboration-request")!, "base64url").toString());
        expect(verifyEd25519(key, requestSigningPayload(signed.signature), signed.proof)).toBe(true);
        expect(signed.signature.path).toBe(u.pathname.replace("/internal/collaboration/drive-context/relay", ""));
        expect(signed.signature.query).toBe(u.search.slice(1));
        expect(signed.signature.bodyDigest).toBe(sha256Hex(new TextEncoder().encode(typeof init?.body === "string" ? init.body : "")));
        if (init?.method === "DELETE")
            return new Response(null, { status: 204 });
        if (u.pathname.endsWith("context/search"))
            return Response.json({ organizationId: ref.organizationId, scopeId, files: [] });
        return Response.json({ status: "text", readOnly: true, text: "current company data", truncated: false, file: { id: fileId, organizationId: ref.organizationId, path, version: 2, size: 20, sha256: "a".repeat(64), updatedBy: "user_owner", updatedAt: at(0) } });
    });
    const client = createDriveContextRuntimeClient({ platformOrigin: "https://app.example", runtimeId: "vps:requester", ownerId: "user_owner", serviceToken: "a".repeat(32), fetchImpl });
    return { client, paths, fetchImpl, setActor(value: string) { actor = value; }, setPath(value: string) { path = value; }, setOrigin(value: string) { origin = value; } };
}
describe("headless drive context proof transport", () => {
    it("uses a fresh owner-bound proof session and closes it after a metadata search", async () => { const f = fixture(); expect(await f.client.search(ref, { query: "plan" })).toMatchObject({ files: [] }); expect(f.paths).toHaveLength(4); expect(f.paths.at(-1)).toContain(`/direct-sessions/${fileId}`); });
    it("reads a file and verifies its scope and selected version", async () => { const f = fixture(); expect(await f.client.read({ ...ref, kind: "file", fileId, version: 2 })).toMatchObject({ text: "current company data", file: { version: 2 } }); expect(f.paths).toHaveLength(4); });
    it("does not return text outside a selected folder", async () => { const f = fixture(); f.setPath("private/other.md"); await expect(f.client.read({ ...ref, kind: "folder", path: "reports" }, fileId)).rejects.toMatchObject({ code: "unavailable" }); expect(f.paths.at(-1)).toContain(`/direct-sessions/${fileId}`); });
    it("rejects another actor before exchanging a ticket", async () => { const f = fixture(); f.setActor("user_other"); await expect(f.client.search(ref, {})).rejects.toMatchObject({ code: "unavailable" }); expect(f.paths).toHaveLength(1); });
    it("does not follow a ticket to a different origin or send enrollment secrets there", async () => { const f = fixture(); f.setOrigin("https://other.example"); await expect(f.client.search(ref, {})).rejects.toMatchObject({ code: "unavailable" }); expect(f.paths).toHaveLength(1); });
    it("preserves a long UTF-8 folder prefix in the signed search body", async () => { const f = fixture(); const path = "部".repeat(260); await f.client.search({ ...ref, kind: "folder", path }, { query: "plan" }); const call = f.fetchImpl.mock.calls.find(([url]) => String(url).includes("context/search"))!; expect(new URL(String(call[0])).search).toBe(""); expect(JSON.parse(call[1]!.body as string)).toMatchObject({ prefix: path, query: "plan" }); });
    it("caps in-flight operations and aborts them on shutdown", async () => { const f = fixture(); f.fetchImpl.mockImplementation((_url, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); })); const pending = Array.from({ length: 4 }, () => f.client.search(ref, {})); const outcomes = Promise.allSettled(pending); await expect(f.client.search(ref, {})).rejects.toMatchObject({ code: "unavailable" }); expect(f.fetchImpl).toHaveBeenCalledTimes(4); f.client.close(); expect((await outcomes).every(value => value.status === "rejected")).toBe(true); await expect(f.client.search(ref, {})).rejects.toMatchObject({ code: "unavailable" }); expect(f.fetchImpl).toHaveBeenCalledTimes(4); });
    it("rejects oversized streamed responses and still closes the session", async () => { const f = fixture(); const original = f.fetchImpl.getMockImplementation()!; f.fetchImpl.mockImplementation(async (url, init) => { const response = await original(url, init); if (String(url).includes("context/search"))
        return new Response(new Uint8Array(128 * 1024 + 1)); return response; }); await expect(f.client.search(ref, {})).rejects.toMatchObject({ code: "unavailable" }); expect(f.paths.at(-1)).toContain(`/direct-sessions/${fileId}`); });
 it("normalizes an invalid upstream response into a safe error",async()=>{const f=fixture();const original=f.fetchImpl.getMockImplementation()!;f.fetchImpl.mockImplementation(async(url,init)=>{const response=await original(url,init);return String(url).includes("context/search")?Response.json({internal_path:"/private/owner"}):response;});await expect(f.client.search(ref,{})).rejects.toMatchObject({code:"unavailable",message:"Company drive context is unavailable"});});

});
