import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware, readPreviewTerminalOwner } from "../../packages/gateway/src/auth.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createTerminalWorkspaceRoutes, terminalRuntimeRefAccess } from "../../packages/gateway/src/shell/workspace-routes.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";
import { buildPlatformUserProof } from "../../packages/platform/src/session-routing-websocket.js";

const platformSecret = "preview-platform-secret-for-regression";
const handle = "pr-1644";
const owner = "user_owner";
const actor = "user_collaborator";
const token = buildPlatformVerificationToken(handle, platformSecret);
const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabId = "tt_0123456789abcdef0123456789abcdef";
const accessHeader = "x-platform-preview-terminal";

function accessProof(actorId = actor, ownerId = owner, runtimeSlot = handle, key = token) {
  const signature = createHmac("sha256", key)
    .update(JSON.stringify(["preview-terminal", actorId, ownerId, runtimeSlot]))
    .digest("hex");
  return `${ownerId}.${signature}`;
}

function headers(userId = actor, access: string | undefined | null = null) {
  const terminalAccess = access === null ? accessProof(userId) : access;
  return {
    authorization: `Bearer ${token}`,
    "x-platform-user-id": userId,
    "x-platform-verified": buildPlatformUserProof(handle, userId, platformSecret),
    ...(terminalAccess ? { [accessHeader]: terminalAccess } : {}),
  };
}

function fixture(projectOperationAdmission?: Parameters<typeof createTerminalWorkspaceRoutes>[0]["projectOperationAdmission"]) {
  const runtime = {
    listWorkspaces: vi.fn(async () => [{ id: workspaceId, tabs: [{ id: tabId, accessScope: "owner" }] }]),
    ensureWorkspace: vi.fn(async () => ({ id: workspaceId })),
    createTab: vi.fn(async () => ({ id: tabId })),
    deletionImpact: vi.fn(),
    deleteWorkspace: vi.fn(),
  };
  const app = new Hono();
  app.use("*", authMiddleware(token));
  app.route("/api/terminal", createTerminalWorkspaceRoutes({
    runtime: runtime as never,
    projectOperationAdmission,
    terminalOwnerIds: [owner],
    getPrincipal: requireRequestPrincipal,
    getPreviewTerminalOwner: readPreviewTerminalOwner,
  }));
  app.get("/ws/terminal/tab", async (c) => {
    const principal = requireRequestPrincipal(c);
    const previewOwner = readPreviewTerminalOwner(c);
    const access = await terminalRuntimeRefAccess(principal, [owner], runtime as never,
      { workspaceId, tabId }, previewOwner);
    return c.json({ access, principal, previewOwner }, access === "allowed" ? 200 : 404);
  });
  app.get("/api/other", (c) => c.json({ principal: requireRequestPrincipal(c),
    previewOwner: readPreviewTerminalOwner(c) }));
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
  it.each([owner, actor, "user_second_collaborator"])("allows terminal operations for %s while preserving actor identity", async (userId) => {
    const { app } = fixture();
    const auth = headers(userId, userId === owner ? "" : accessProof(userId));
    expect((await app.request("/api/terminal/workspaces", { headers: auth })).status).toBe(200);
    expect((await app.request("/api/terminal/workspaces/ensure", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    })).status).toBe(200);
    expect((await app.request(`/api/terminal/workspaces/${workspaceId}/tabs`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Shared", cwd: "/" }),
    })).status).toBe(201);
    const attach = await app.request("/ws/terminal/tab", { headers: auth });
    expect(attach.status).toBe(200);
    expect((await attach.json()).principal).toEqual({ userId, source: "platform-verified" });
  });

  it.each([
    ["missing", ""],
    ["malformed", "not-a-proof"],
    ["oversized", "x".repeat(513)],
    ["wrong signature", accessProof(actor, owner, handle, "wrong-key")],
    ["other actor", accessProof("user_other")],
    ["other owner", accessProof(actor, "user_other")],
    ["other runtime", accessProof(actor, owner, "pr-9999")],
  ])("denies %s access before reading runtime", async (_name, access) => {
    const { app, runtime } = fixture();
    for (const path of ["/api/terminal/workspaces", "/ws/terminal/tab"]) {
      expect((await app.request(path, { headers: headers(actor, access) })).status).toBe(404);
    }
    expect(runtime.listWorkspaces).not.toHaveBeenCalled();
  });

  it("keeps authorization outside RequestPrincipal and outside non-terminal routes", async () => {
    const { app } = fixture();
    await expect((await app.request("/api/other", { headers: headers() })).json()).resolves.toEqual({
      principal: { userId: actor, source: "platform-verified" },
    });
  });

  it("uses canonical ownership for project admission while preserving the actor", async () => {
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
});
