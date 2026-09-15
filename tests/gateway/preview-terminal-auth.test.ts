import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createTerminalWorkspaceRoutes, terminalRuntimeRefAccess } from "../../packages/gateway/src/shell/workspace-routes.js";
import { issueSyncJwt } from "../../packages/platform/src/sync-jwt.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { buildPlatformUserProof } from "../../packages/platform/src/session-routing-websocket.js";

const platformSecret = "preview-platform-secret-for-regression";
const handle = "pr-1644";
const owner = "user_owner";
const actor = "user_collaborator";
const token = buildPlatformVerificationToken(handle, platformSecret);
const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabId = "tt_0123456789abcdef0123456789abcdef";
const header = "x-platform-preview-terminal";
function proof(overrides: Record<string, unknown> = {}, key = token) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    version: 1, scope: "preview-terminal", provisioningClass: "preview",
    role: "preview-collaborator", actorId: actor, ownerId: owner,
    handle, runtimeSlot: handle, issuedAt: now, expiresAt: now + 30,
    ...overrides,
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(`preview-terminal-v1:${payload}`).digest("hex")}`;
}
function headers(userId = actor, delegation: string | undefined = proof()) {
  return {
    authorization: `Bearer ${token}`,
    "x-platform-user-id": userId,
    "x-platform-verified": buildPlatformUserProof(handle, userId, platformSecret),
    ...(delegation ? { [header]: delegation } : {}),
  };
}
function fixture(projectOperationAdmission?: Parameters<typeof createTerminalWorkspaceRoutes>[0]["projectOperationAdmission"]) {
  const runtime = {
    listWorkspaces: vi.fn(async () => [{ id: workspaceId, tabs: [{ id: tabId, accessScope: "owner" }] }]),
    ensureWorkspace: vi.fn(async () => ({ id: workspaceId })),
    createTab: vi.fn(async () => ({ id: tabId })),
    deletionImpact: vi.fn(), deleteWorkspace: vi.fn(),
  };
  const app = new Hono();
  app.use("*", authMiddleware(token));
  app.route("/api/terminal", createTerminalWorkspaceRoutes({
    runtime: runtime as never, projectOperationAdmission, terminalOwnerIds: [owner], getPrincipal: requireRequestPrincipal,
  }));
  app.get("/ws/terminal/tab", async (c) => {
    const principal = requireRequestPrincipal(c);
    const access = await terminalRuntimeRefAccess(principal, [owner], runtime as never, { workspaceId, tabId });
    return c.json({ access, principal }, access === "allowed" ? 200 : 404);
  });
  app.get("/api/other", (c) => c.json(requireRequestPrincipal(c)));
  return { app, runtime };
}
beforeEach(() => {
  vi.stubEnv("MATRIX_HANDLE", handle);
  vi.stubEnv("MATRIX_RUNTIME_SLOT", handle);
  vi.stubEnv("MATRIX_USER_ID", owner);
  vi.stubEnv("MATRIX_CLERK_USER_ID", owner);
  vi.stubEnv("PLATFORM_JWT_SECRET", "");
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());
describe("preview terminal authorization", () => {
  it.each([owner, actor, "user_second_collaborator"])("allows list, ensure, create and ref attachment for %s, preserving actor", async (userId) => {
    const { app } = fixture();
    const auth = headers(userId, userId === owner ? "" : proof({ actorId: userId }));
    expect((await app.request("/api/terminal/workspaces", { headers: auth })).status).toBe(200);
    expect((await app.request("/api/terminal/workspaces/ensure", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    })).status).toBe(200);
    expect((await app.request(`/api/terminal/workspaces/${workspaceId}/tabs`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Shared", cwd: "/" }),
    })).status).toBe(201);
    const attach = await app.request("/ws/terminal/tab", { headers: auth });
    expect(attach.status).toBe(200);
    expect((await attach.json()).principal.userId).toBe(userId);
  });
  it.each([
    ["missing", ""], ["malformed", "not-a-proof"], ["oversized", "x".repeat(8193)],
    ["wrong signature", proof({}, "wrong-key")], ["expired", proof({ issuedAt: 1, expiresAt: 31 })],
    ["future", proof({ issuedAt: 9_000_000_000, expiresAt: 9_000_000_030 })],
    ["unbounded lifetime", proof({ expiresAt: Math.floor(Date.now() / 1000) + 3600 })],
    ["other actor", proof({ actorId: "user_other" })], ["other owner", proof({ ownerId: "user_other" })],
    ["other handle", proof({ handle: "pr-9999" })], ["other runtime", proof({ runtimeSlot: "preview" })],
    ["customer", proof({ provisioningClass: "customer" })], ["other role", proof({ role: "owner" })],
    ["other scope", proof({ scope: "all" })],
  ])("denies %s delegation before reading runtime", async (_name, delegation) => {
    const { app, runtime } = fixture();
    for (const path of ["/api/terminal/workspaces", "/ws/terminal/tab"]) {
      expect((await app.request(path, { headers: headers(actor, delegation) })).status).toBe(404);
    }
    expect(runtime.listWorkspaces).not.toHaveBeenCalled();
  });
  it("keeps JWT identity authoritative and requires delegation for direct WS tokens", async () => {
    const secret = "jwt-secret-preview-regression-at-least-32";
    vi.stubEnv("PLATFORM_JWT_SECRET", secret);
    const issued = await issueSyncJwt({ secret, clerkUserId: actor, handle, runtimeSlot: handle,
      gatewayUrl: "https://app.matrix-os.com" });
    const { app } = fixture();
    const jwtHeaders = { ...headers(owner), authorization: `Bearer ${issued.token}` };
    const http = await app.request("/api/terminal/workspaces", { headers: jwtHeaders });
    expect(http.status).toBe(200);
    const ws = await app.request("/ws/terminal/tab", { headers: jwtHeaders });
    expect((await ws.json()).principal).toMatchObject({ userId: actor, source: "jwt" });
    expect((await app.request("/ws/terminal/tab", { headers: { ...jwtHeaders,
      [header]: proof({ actorId: owner }) } })).status).toBe(404);
    expect((await app.request(`/ws/terminal/tab?token=${issued.token}`)).status).toBe(404);
  });
  it("uses canonical ownership for project admission while preserving the principal", async () => {
    const admission = { withLegacyAdmission: vi.fn(async (_scope, operation) => operation()) };
    const { app } = fixture(admission as never);
    expect((await app.request("/api/terminal/workspaces/ensure", {
      method: "POST", headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ projectId: "shared-project" }),
    })).status).toBe(200);
    expect(admission.withLegacyAdmission).toHaveBeenCalledWith({
      ownerType: "personal", ownerId: owner, projectId: "shared-project", kind: "run",
    }, expect.any(Function));
  });
  it("never delegates outside terminal routes or changes global ownership", async () => {
    const { app } = fixture();
    expect(await (await app.request("/api/other", { headers: headers() })).json()).toEqual({ userId: actor, source: "platform-verified" });
  });
  it("rejects replay against another gateway even with a matching local bearer", async () => {
    vi.stubEnv("MATRIX_HANDLE", "pr-9999");
    const { app } = fixture();
    expect((await app.request("/api/terminal/workspaces", { headers: headers() })).status).toBe(404);
  });
  it("fails closed when the runtime slot is missing", async () => {
    vi.stubEnv("MATRIX_RUNTIME_SLOT", "");
    const { app } = fixture();
    expect((await app.request("/api/terminal/workspaces", { headers: headers() })).status).toBe(404);
  });
});
