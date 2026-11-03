import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborationAuthorizationError } from "../../packages/gateway/src/collaboration/authority-error.js";
import { Hono } from "hono";
import { markAuthContextReady, setPlatformVerifiedPrincipal } from "../../packages/gateway/src/request-principal.js";
import { CompanyBrainError, type CompanyBrainService } from "../../packages/gateway/src/company-brain/service.js";
import { createCompanyBrainRoutes } from "../../packages/gateway/src/company-brain/routes.js";
import { PublishBrainSourceSchema, SearchBrainSchema } from "../../packages/gateway/src/company-brain/schemas.js";

const scope = "10000000-0000-4000-8000-000000000001";
const sourceId = "a".repeat(64);
const base = `/brain/scopes/${scope}`;
const source = { sourceId, audienceScopeId: scope, title: "Decision", text: "Launch tomorrow", permalink: "https://example.com/decision", sourceUpdatedAt: "2026-09-30T10:00:00.000Z", expectedRevision: 0 };
const service = { publish: vi.fn(), search: vi.fn(), get: vi.fn(), export: vi.fn(), remove: vi.fn(), erase: vi.fn() };
function app(actor: string | null = "user_owner") {
  const app = new Hono();
  app.use("*", async (c, next) => { markAuthContextReady(c); if (actor) setPlatformVerifiedPrincipal(c, actor); await next(); });
  app.route("/brain", createCompanyBrainRoutes({ service: service as unknown as CompanyBrainService,
    principalConfig: { isProduction: true, isLocalDevelopment: false, configuredUserId: undefined, isTrustedSingleUserGateway: false } }));
  return app;
}

describe("Company Brain route validation and verified actor binding", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it("binds publication actor from authenticated principal, never payload", async () => {
    service.publish.mockResolvedValue({ sourceId, revision: 1 });
    const response = await app().request(`${base}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(source) });
    expect(response.status).toBe(201);
    expect(service.publish).toHaveBeenCalledWith(scope, "user_owner", source);
    expect((await app().request(`${base}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...source, actorId: "user_owner" }) })).status).toBe(400);
  });
  it.each(["title", "text"] as const)("rejects embedded NUL in source %s at the actual schema boundary", (field) => {
    expect(PublishBrainSourceSchema.safeParse({ ...source, [field]: "notes\u0000more" }).success).toBe(false);
  });
  it("rejects embedded NUL in search at the actual schema boundary", () => {
    expect(SearchBrainSchema.safeParse({ query: "notes\u0000more" }).success).toBe(false);
  });
  it.each(["title", "text"] as const)("returns 400 before publication for embedded NUL in source %s", async (field) => {
    service.publish.mockResolvedValue({ sourceId, revision: 1 });
    const response = await app().request(`${base}/sources`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...source, [field]: "notes\u0000more" }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Company Brain request" });
    expect(service.publish).not.toHaveBeenCalled();
  });
  it("returns 400 before search for a percent-encoded embedded NUL query", async () => {
    service.search.mockResolvedValue([]);
    const response = await app().request(`${base}/search?q=notes%00more`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid Company Brain request" });
    expect(service.search).not.toHaveBeenCalled();
  });
  it("preserves Unicode and ordinary whitespace through publication and search", async () => {
    const input = { ...source, title: "Décision 🚀", text: "Line one\nLine two\tЖ" }, query = "Décision 🚀";
    expect(PublishBrainSourceSchema.parse(input)).toEqual(input);
    expect(SearchBrainSchema.parse({ query })).toEqual({ query, limit: 5 });
    service.publish.mockResolvedValue({ sourceId, revision: 1 });
    service.search.mockResolvedValue([]);
    expect((await app().request(`${base}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status).toBe(201);
    expect(service.publish).toHaveBeenCalledWith(scope, "user_owner", input);
    expect((await app().request(`${base}/search?q=${encodeURIComponent(query)}`)).status).toBe(200);
    expect(service.search).toHaveBeenCalledWith(scope, "user_owner", { query, limit: 5 });
  });
  it("requires authenticated access before invoking source reads", async () => {
    expect((await app(null).request(`${base}/search?q=launch`)).status).toBe(401);
    expect(service.search).not.toHaveBeenCalled();
  });
  it("validates scope, source, search and delete revisions at the route boundary", async () => {
    for (const path of ["/brain/scopes/not-a-uuid/search?q=x", `${base}/search?q=`, `${base}/search?q=x&limit=21`, `${base}/sources/not-a-hash`]) {
      expect((await app().request(path)).status).toBe(400);
    }
    expect((await app().request(`${base}/sources/${sourceId}?expectedRevision=nope`, { method: "DELETE" })).status).toBe(400);
    expect(service.search).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });
  it("limits POST and all DELETE bodies before service calls", async () => {
    for (const [path, method] of [[`${base}/sources`, "POST"], [`${base}/sources/${sourceId}?expectedRevision=1`, "DELETE"], [base, "DELETE"]]) {
      const response = await app().request(path, { method, body: "x".repeat(450_000) });
      expect(response.status).toBe(413);
    }
    expect(service.publish).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
    expect(service.erase).not.toHaveBeenCalled();
  });
  it.each(["Ж".repeat(30_000), "\u0001".repeat(65_528)])("accepts a valid decoded source even when JSON escaping expands its wire size", async (text) => {
    const input = { ...source, text };
    const body = JSON.stringify(input).replace(/[^\u0000-\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    expect(Buffer.byteLength(body)).toBeGreaterThan(140_000);
    expect(Buffer.byteLength(input.text) + Buffer.byteLength(input.title)).toBeLessThanOrEqual(65_536);
    service.publish.mockResolvedValue({ sourceId, revision: 1 });
    const response = await app().request(`${base}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(201);
    expect(service.publish).toHaveBeenCalledWith(scope, "user_owner", input);
  });
  it("rejects decoded source content above 64 KiB even within the wire cap", async () => {
    const response = await app().request(`${base}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...source, text: "x".repeat(65_536) }) });
    expect(response.status).toBe(400);
    expect(service.publish).not.toHaveBeenCalled();
  });
  it("maps service conflict and unexpected errors to safe responses", async () => {
    service.publish.mockRejectedValueOnce(new CompanyBrainError("conflict"));
    const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(source) };
    expect((await app().request(`${base}/sources`, request)).status).toBe(409);
    service.publish.mockRejectedValueOnce(new Error("postgres://private_host provider secret /private/path"));
    const response = await app().request(`${base}/sources`, request);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
  it("fails closed when auth middleware was not initialized or offers an anonymous development identity",async()=>{
    const uninitialized=new Hono();
    uninitialized.route("/brain",createCompanyBrainRoutes({service:service as unknown as CompanyBrainService}));
    expect((await uninitialized.request(`${base}/search?q=launch`)).status).toBe(500);
    const anonymous=new Hono();
    anonymous.use("*",async(c,next)=>{markAuthContextReady(c);await next();});
    anonymous.route("/brain",createCompanyBrainRoutes({service:service as unknown as CompanyBrainService,principalConfig:{configuredUserId:undefined,isTrustedSingleUserGateway:false,isLocalDevelopment:true,isProduction:false,authEnabled:false}}));
    expect((await anonymous.request(`${base}/search?q=launch`)).status).toBe(401);
    expect(service.search).not.toHaveBeenCalled();
  });

  it.each([["not_found",404],["forbidden",403],["capacity",429]] as const)("returns a safe %s result",async(code,status)=>{
    service.search.mockRejectedValueOnce(new CompanyBrainError(code));
    const response=await app().request(`${base}/search?q=launch`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({error:"Company Brain unavailable",code});
  });
  it("maps collaboration outage and malformed request syntax safely",async()=>{
    service.search.mockRejectedValueOnce(new CollaborationAuthorizationError("unavailable","Private organization runtime detail"));
    const unavailable=await app().request(`${base}/search?q=launch`);
    expect(unavailable.status).toBe(503);expect(await unavailable.text()).not.toContain("Private");
    expect((await app().request(`${base}/sources`,{method:"POST",headers:{"content-type":"application/json"},body:"{"})).status).toBe(400);
    expect((await app().request(`${base}/sources/${sourceId}`,{method:"DELETE"})).status).toBe(400);
  });

  it("wires bounded search, source reads, owner export and deletion", async () => {
    service.search.mockResolvedValue([]);
    service.get.mockResolvedValue({ sourceId });
    service.export.mockResolvedValue({ documents: [] });
    expect((await app().request(`${base}/search?q=launch&limit=3`)).status).toBe(200);
    expect(service.search).toHaveBeenCalledWith(scope, "user_owner", { query: "launch", limit: 3 });
    expect((await app().request(`${base}/sources/${sourceId}`)).status).toBe(200);
    expect((await app().request(`${base}/export`)).status).toBe(200);
    expect((await app().request(`${base}/sources/${sourceId}?expectedRevision=1`, { method: "DELETE" })).status).toBe(200);
    expect(service.remove).toHaveBeenCalledWith(scope, "user_owner", sourceId, 1);
    expect((await app().request(base, { method: "DELETE" })).status).toBe(200);
    expect(service.erase).toHaveBeenCalledWith(scope, "user_owner");
  });
});
