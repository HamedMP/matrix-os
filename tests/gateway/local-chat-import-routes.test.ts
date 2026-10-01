import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createLocalChatImportRoutes } from "../../packages/gateway/src/chat/local-import/routes.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";
const jobId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
function setup(auth = true) {
  const jobs = { begin: vi.fn(async () => ({ jobId, status: "uploading" })), get: vi.fn(async () => ({ jobId, status: "uploaded" })),
    presignParts: vi.fn(async () => []), acknowledgePart: vi.fn(async () => ({})), completeArchive: vi.fn(async () => ({ jobId, status: "uploaded" })), cancel: vi.fn(async () => ({})) };
  const publisher = { archiveUrl: vi.fn(async () => ({})), assetContent: vi.fn(async () => new Response("asset")) };
  const wake = vi.fn(); const app = new Hono().route("/", createLocalChatImportRoutes({ jobs, publisher, wake,
    getPrincipal: () => { if (!auth) throw new MissingRequestPrincipalError(); return { userId: "synthetic_owner", source: "jwt" as const }; } }));
  return { app, jobs, publisher, wake };
}
const post = (app: Hono, path: string, body: unknown = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
describe("owner-private local Chat import API", () => {
  it("requires authentication before beginning or reading archives", async () => {
    const x = setup(false); expect((await post(x.app, "/api/chats/imports/local", {})).status).toBe(401);
    expect((await x.app.request(`/api/chats/imports/local/${jobId}/archive`)).status).toBe(401);
    expect(x.jobs.begin).not.toHaveBeenCalled(); expect(x.publisher.archiveUrl).not.toHaveBeenCalled();
  });
  it("validates path IDs and small request bodies before touching storage", async () => {
    const x = setup(); expect((await post(x.app, "/api/chats/imports/local/bad/complete")).status).toBe(400);
    expect((await post(x.app, "/api/chats/imports/local", { large: "x".repeat(9000) })).status).toBe(413);
    expect(x.jobs.completeArchive).not.toHaveBeenCalled(); expect(x.jobs.begin).not.toHaveBeenCalled();
  });
  it("queues verified publication without keeping the HTTP request open", async () => {
    const x = setup(); const response = await post(x.app, `/api/chats/imports/local/${jobId}/complete`);
    expect(response.status).toBe(202); expect(x.wake).toHaveBeenCalledTimes(1);
    expect(x.jobs.completeArchive).toHaveBeenCalledWith({ type: "personal", ownerId: "synthetic_owner" }, jobId);
  });
  it("limits DELETE request bodies and cancels only the authenticated owner's job", async () => {
    const x = setup(); const response = await x.app.request(`/api/chats/imports/local/${jobId}`, { method: "DELETE" });
    expect(response.status).toBe(200); expect(x.jobs.cancel).toHaveBeenCalledWith({ type: "personal", ownerId: "synthetic_owner" }, jobId);
    const big = await x.app.request(`/api/chats/imports/local/${jobId}`, { method: "DELETE", body: "x".repeat(9000) }); expect(big.status).toBe(413);
  });
  it("serves only a validated Chat asset through an authenticated gateway content route", async () => {
    const x = setup(); const response = await x.app.request(`/api/chats/chat_synthetic/imports/assets/${jobId}/content`);
    expect(response.status).toBe(200); expect(await response.text()).toBe("asset");
    expect(x.publisher.assetContent).toHaveBeenCalledWith({ type: "personal", ownerId: "synthetic_owner" }, "chat_synthetic", jobId, expect.any(AbortSignal));
  });
});
