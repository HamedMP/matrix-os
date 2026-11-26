import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { markVerifiedRuntimeBearer, MissingRequestPrincipalError } from "../../../packages/gateway/src/request-principal.js";

const ownerId = "user_owner_1";
const agentId = "bot_0123456789abcdef";
const path = `/api/chat-agents/${agentId}/resource-grants`;
const candidateId = "source_0123456789abcdef0123456789abcdef0123456789abcdef";
const grantId = "rgr_0123456789abcdef0123456789abcdef";
const kind = "github_repository";
const label = "matrix-qa/review-fixture";
const grant = { id: grantId, kind, label, revision: 1 } as const;
const revoked = { grantId, revokedAt: "2026-11-26T12:00:00.000Z" };

function harness() {
  const resourceGrants = {
    list: vi.fn(async () => ({ candidates: [{ id: candidateId, kind, label }], grants: [] })),
    grant: vi.fn(async () => ({ grant })),
    revoke: vi.fn(async () => revoked),
  };
  const app = createBotRoutes({ resourceGrants, getPrincipal: () => ({ userId: ownerId, source: "jwt" }) });
  return { app, resourceGrants };
}

const json = (method: "POST" | "DELETE", payload: object) => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
});

describe("owner Agent resource grant HTTP routes", () => {
  it("lists private candidates and passes the verified owner, exact Agent, and approved candidate to the service", async () => {
    const { app, resourceGrants } = harness();
    const list = await app.request(path, { headers: { "X-Platform-User-Id": "other_user" } });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(await list.json()).toEqual({ candidates: [{ id: candidateId, kind, label }], grants: [] });
    expect(resourceGrants.list).toHaveBeenCalledWith(ownerId, agentId);

    const saved = await app.request(path, json("POST", { candidateId }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ grant });
    expect(resourceGrants.grant).toHaveBeenCalledWith(ownerId, agentId, candidateId);

    const removed = await app.request(`${path}/${grantId}`, json("DELETE", { baseRevision: 1 }));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual(revoked);
    expect(resourceGrants.revoke).toHaveBeenCalledWith(ownerId, agentId, grantId, 1);
  });

  it("refuses missing principals, malformed IDs, attempts to provide scopes directly, and oversized mutation bodies", async () => {
    const { app, resourceGrants } = harness();
    const signedOut = createBotRoutes({ resourceGrants, getPrincipal: () => { throw new MissingRequestPrincipalError(); } });
    expect((await signedOut.request(path)).status).toBe(401);
    const configuredIdentity = createBotRoutes({ resourceGrants, getPrincipal: () => ({ userId: ownerId, source: "configured-container" }) });
    expect((await configuredIdentity.request(path, json("POST", { candidateId }))).status).toBe(403);
    expect((await app.request("/api/chat-agents/wrong/resource-grants")).status).toBe(400);
    expect((await app.request(path, json("POST", { candidateId, teamId: "T1234", channelId: "C1234567" }))).status).toBe(400);
    expect((await app.request(path, { ...json("POST", { candidateId }), headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    expect((await app.request(`${path}/${grantId}`, json("DELETE", { baseRevision: 0 }))).status).toBe(400);
    expect((await app.request(`${path}/${grantId}`, { ...json("DELETE", { baseRevision: 1 }), headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    expect((await app.request(`${path}/wrong`, json("DELETE", { baseRevision: 1 }))).status).toBe(400);
    expect((await app.request(path, json("POST", { candidateId: "x".repeat(10_000) }))).status).toBe(413);
    expect((await app.request(`${path}/${grantId}`, json("DELETE", { baseRevision: 1, value: "x".repeat(10_000) }))).status).toBe(413);
    expect(resourceGrants.list).not.toHaveBeenCalled();
    expect(resourceGrants.grant).not.toHaveBeenCalled();
    expect(resourceGrants.revoke).not.toHaveBeenCalled();
  });

  it("accepts a signed browser owner and excludes a run-scoped actor with the same user ID", async () => {
    const { resourceGrants } = harness();
    const getPrincipal = () => ({ userId: ownerId, source: "platform-verified" as const });
    const routes = createBotRoutes({ resourceGrants, getPrincipal });
    expect((await routes.request(path, json("POST", { candidateId }))).status).toBe(403);
    expect(resourceGrants.grant).not.toHaveBeenCalled();

    const browser = new Hono();
    browser.use("*", async (context, next) => { markVerifiedRuntimeBearer(context); await next(); });
    browser.route("/", routes);
    expect((await browser.request(path, json("POST", { candidateId }))).status).toBe(200);
    expect(resourceGrants.grant).toHaveBeenCalledExactlyOnceWith(ownerId, agentId, candidateId);
  });
});
