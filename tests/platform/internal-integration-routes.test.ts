import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import {
  insertContainer,
  insertUserMachine,
  type PlatformDB,
} from "../../packages/platform/src/db.js";
import { createApp } from "../../packages/platform/src/main.js";
import { createJevLabelCallRoutes, authorizeInternalJevLabels } from "../../packages/gateway/src/integrations/jev-label-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
import { mintChatPermissionModeProof } from "../../packages/platform/src/chat-permission-mode-proof.js";
import { mintCustomMcpApprovalProof } from "../../packages/platform/src/custom-mcp-approval-proof.js";

function bearerFor(handle: string, secret: string): string {
  return createHmac("sha256", secret).update(handle).digest("hex");
}

function delegatedHeaders(handle: string, userId: string, secret = "platform-secret-123") {
  return {
    authorization: `Bearer ${bearerFor(handle, secret)}`,
    "x-platform-user-id": userId,
    "x-platform-verified": createHmac("sha256", bearerFor(handle, secret)).update(userId).digest("hex"),
  };
}

describe("platform/internal-integration-routes", () => {
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertContainer(db, {
      handle: "alice",
      clerkUserId: "user_alice",
      port: 5001,
      shellPort: 6001,
      status: "running",
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function stubOrchestrator(): Orchestrator {
    return {
      provision: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      upgrade: vi.fn(),
      rollingRestart: vi.fn(),
      getInfo: vi.fn(),
      getImage: vi.fn(),
      listAll: vi.fn().mockReturnValue([]),
      syncStates: vi.fn(),
    };
  }

  function createTestApp() {
    const internalRoutes = new Hono();
    internalRoutes.get("/probe", (c) =>
      c.json({
        clerkUserId: c.get("internalContainerClerkUserId"),
      }),
    );

    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: "platform-secret-123",
      internalIntegrationRoutes: internalRoutes,
    });
  }

  it("verifies exact owner permission changes without optional Pipedream routes", async () => {
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123" });
    const body = { chatId: "chat_builtin", runId: "run_builtin", clientRequestId: "req_builtin", permissionMode: "full_access" };
    const proof = (actorId = "user_alice") => mintChatPermissionModeProof({ method: "POST", path: "/api/chats/chat_builtin/runs/run_builtin/permission-mode",
      body: JSON.stringify({ clientRequestId: body.clientRequestId, permissionMode: body.permissionMode }), secret: "platform-secret-123",
      identity: { handle: "alice", userId: actorId, source: "auth" } })!;
    const path = "/internal/containers/alice/integrations/permission-mode/verify";
    const headers = { authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`, "content-type": "application/json", "x-matrix-chat-permission-mode-proof": proof() };
    const response = await app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verified: true });
    for (const change of [{ runId: "run_other" }, { chatId: "chat_other" }, { clientRequestId: "req_other" }, { permissionMode: "supervised" }]) {
      expect((await app.request(path, { method: "POST", headers, body: JSON.stringify({ ...body, ...change }) })).status).toBe(403);
    }
    for (const candidate of ["forged", proof("user_other")]) expect((await app.request(path, { method: "POST",
      headers: { ...headers, "x-matrix-chat-permission-mode-proof": candidate }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await app.request(path, { method: "POST", headers: { ...headers, authorization: "Bearer forged" }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await app.request(path, { method: "POST", body: JSON.stringify(body) })).status).toBe(401);
    expect((await app.request(path, { method: "POST", headers, body: "invalid" })).status).toBe(400);
    expect((await app.request(path, { method: "POST", headers, body: "x".repeat(4001) })).status).toBe(413);
    // Optional personal-account endpoints retain their absent-service behavior.
    expect((await app.request("/internal/containers/alice/integrations/probe")).status).toBe(401);
    expect((await app.request("/internal/containers/alice/integrations/approval/verify", { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(401);
  });

  it.each([
    { handle: "pr-3912", provisioningClass: "preview" as const },
    { handle: "pv-3912-1234abcd", provisioningClass: "private-preview" as const },
  ])("keeps $provisioningClass permission verification denied without owner-only eligibility", async ({ handle, provisioningClass }) => {
    await insertUserMachine(db, { machineId: "00000000-0000-4000-8000-000000003912", clerkUserId: "user_preview_owner", handle,
      runtimeSlot: handle, provisioningClass, status: "running", provisionedAt: new Date().toISOString(),
      ...(provisioningClass === "private-preview" ? { sourcePr: 3912, confirmedBundleVersion: "v2026.11.14-pr3912-1-abcdef0" } : {}) });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123" });
    const body = { chatId: "chat_builtin", runId: "run_builtin", clientRequestId: "req_builtin", permissionMode: "full_access" };
    const proof = mintChatPermissionModeProof({ method: "POST", path: "/api/chats/chat_builtin/runs/run_builtin/permission-mode",
      body: JSON.stringify({ clientRequestId: body.clientRequestId, permissionMode: body.permissionMode }), secret: "platform-secret-123",
      identity: { handle, userId: "user_preview_owner", source: "auth" } })!;
    expect((await app.request(`/internal/containers/${handle}/integrations/permission-mode/verify`, { method: "POST",
      headers: { authorization: `Bearer ${bearerFor(handle, "platform-secret-123")}`, "content-type": "application/json", "x-matrix-chat-permission-mode-proof": proof }, body: JSON.stringify(body) })).status).toBe(403);
  });

  it("keeps provider-independent permission verification subject to live Private Preview membership", async () => {
    const handle = "pv-3912-1234abcd";
    await insertUserMachine(db, { machineId: "00000000-0000-4000-8000-000000003912", clerkUserId: "user_preview_owner", handle,
      runtimeSlot: handle, provisioningClass: "private-preview", status: "running", provisionedAt: new Date().toISOString(),
      sourcePr: 3912, confirmedBundleVersion: "v2026.11.14-pr3912-1-abcdef0" });
    const membership = vi.fn(async () => true);
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123",
      privatePreviewMembership: membership, env: { ...process.env, MATRIX_INTERNAL_CLERK_ORG_ID: "org_internaltest" } });
    const body = { chatId: "chat_builtin", runId: "run_builtin", clientRequestId: "req_builtin", permissionMode: "full_access" };
    const proof = mintChatPermissionModeProof({ method: "POST", path: "/api/chats/chat_builtin/runs/run_builtin/permission-mode",
      body: JSON.stringify({ clientRequestId: body.clientRequestId, permissionMode: body.permissionMode }), secret: "platform-secret-123",
      identity: { handle, userId: "user_preview_owner", source: "auth" } })!;
    const request = () => app.request(`/internal/containers/${handle}/integrations/permission-mode/verify`, { method: "POST",
      headers: { authorization: `Bearer ${bearerFor(handle, "platform-secret-123")}`, "content-type": "application/json", "x-matrix-chat-permission-mode-proof": proof }, body: JSON.stringify(body) });
    expect((await request()).status).toBe(200);
    expect(membership).toHaveBeenCalledWith("org_internaltest", "user_preview_owner");
    membership.mockResolvedValue(false);
    expect((await request()).status).toBe(403);
  });

  it("requires signed machine delegation before the Gmail label seam can dispatch", async () => {
    const labels = vi.fn(async () => ({ labels: [] }));
    const lookup = vi.fn(async () => [{ id: "conn_1", user_id: "owner_1", service: "gmail", status: "active",
      account_label: "My Gmail", account_email: "me@example.test", pipedream_account_id: "apn_1" }]);
    const internalRoutes = createJevLabelCallRoutes({
      db: { listConnectedServices: lookup, getUserById: async () => ({ pipedream_external_id: "owner_1" }) } as unknown as PlatformDb,
      pipedream: { boundedGmailGet: async () => ({ emailAddress: "me@example.test" }), boundedGmailLabels: labels } as unknown as PipedreamConnectClient,
      resolveUserId: async c => c.get("internalContainerClerkUserId") === "user_alice" ? "owner_1" : null,
      authorizeInternal: authorizeInternalJevLabels,
    });
    const app = createApp({ db, orchestrator: stubOrchestrator(), platformSecret: "platform-secret-123",
      internalIntegrationRoutes: internalRoutes });
    const body = JSON.stringify({ binding: { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_1",
      expectedEmail: "me@example.test", labelingEnabled: true }, operation: { kind: "labels" } });
    for (const [headers, expected] of [
      [{ authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}` }, 403],
      [{ ...delegatedHeaders("alice", "user_alice"), "x-platform-verified": "forged" }, 401],
      [delegatedHeaders("alice", "user_stranger"), 403],
    ] as const) {
      const response = await app.request("/internal/containers/alice/integrations/jev-label-call", {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body });
      expect(response.status).toBe(expected);
      expect(lookup).not.toHaveBeenCalled();
      expect(labels).not.toHaveBeenCalled();
    }
    const response = await app.request("/internal/containers/alice/integrations/jev-label-call", {
      method: "POST", headers: { "content-type": "application/json", ...delegatedHeaders("alice", "user_alice") }, body });
    expect(response.status).toBe(200);
    expect(labels).toHaveBeenCalledTimes(1);
  });

  it("rejects requests without the per-container bearer token", async () => {
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/integrations/probe");

    expect(res.status).toBe(401);
  });

  it("verifies an exact browser decision for a customer integration action", async () => {
    const body = { chatId: "chat_1", runId: "run_1", approvalId: "approval_1", decision: "approve", clientRequestId: "req_1" };
    const proof = mintCustomMcpApprovalProof({ method: "POST", path: "/api/chats/chat_1/runs/run_1/approvals/approval_1",
      identity: { handle: "alice", userId: "user_alice", source: "auth" },
      body: JSON.stringify({ clientRequestId: "req_1", decision: "approve" }), secret: "platform-secret-123" });
    const response = await createTestApp().request("/internal/containers/alice/integrations/approval/verify", {
      method: "POST", headers: { authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
        "content-type": "application/json", "x-matrix-custom-mcp-approval-proof": proof! }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ verified: true });
    for (const [decision, candidate] of [[body, "forged"], [body, undefined], [{ ...body, clientRequestId: "req_other" }, proof],
      [{ ...body, runId: "run_other" }, proof], [{ ...body, decision: "decline" }, proof]] as const) {
      const rejected = await createTestApp().request("/internal/containers/alice/integrations/approval/verify", {
        method: "POST", headers: { authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`, "content-type": "application/json",
          ...(candidate ? { "x-matrix-custom-mcp-approval-proof": candidate } : {}) }, body: JSON.stringify(decision),
      });
      expect(rejected.status).toBe(403);
    }
  });

  it("passes authenticated requests through with the resolved clerk user id", async () => {
    const app = createTestApp();

    const res = await app.request("/internal/containers/alice/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("alice", "platform-secret-123")}`,
      },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clerkUserId: "user_alice" });
  });

  it("rejects owner-scoped integrations from a preview VPS", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001298",
      clerkUserId: "user_preview_owner",
      handle: "pr-1298",
      runtimeSlot: "pr-1298",
      provisioningClass: "preview",
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const app = createTestApp();

    const res = await app.request("/internal/containers/pr-1298/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("pr-1298", "platform-secret-123")}`,
      },
    });

    expect(res.status).toBe(403);
  });

  it.each(["running", "provisioning"] as const)("does not select a customer owner when a %s preview shares its handle", async (previewStatus) => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001306",
      clerkUserId: "user_customer_owner",
      handle: "pr-1306",
      runtimeSlot: "primary",
      provisioningClass: "customer",
      status: "running",
      provisionedAt: "2026-09-25T00:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001307",
      clerkUserId: "user_preview_owner",
      handle: "pr-1306",
      runtimeSlot: "pr-1306",
      provisioningClass: "preview",
      status: previewStatus,
      provisionedAt: "2026-09-25T00:00:00.000Z",
    });
    const res = await createTestApp().request("/internal/containers/pr-1306/integrations/probe", {
      headers: { authorization: `Bearer ${bearerFor("pr-1306", "platform-secret-123")}` },
    });
    expect(res.status).toBe(403);
  });

  it("rejects delegated integration calls from a shared preview VPS", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001299",
      clerkUserId: "user_preview_owner",
      handle: "pr-1299",
      runtimeSlot: "pr-1299",
      provisioningClass: "preview",
      accessClerkUserIds: ["user_collaborator"],
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const res = await createTestApp().request("/internal/containers/pr-1299/integrations/probe", {
      headers: delegatedHeaders("pr-1299", "user_collaborator"),
    });
    expect(res.status).toBe(403);
  });

  it("accepts an unsigned owner header from a legacy single-user customer gateway", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001301",
      clerkUserId: "user_customer_owner",
      handle: "customer-1301",
      runtimeSlot: "main",
      provisioningClass: "customer",
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const app = createTestApp();
    const res = await app.request("/internal/containers/customer-1301/integrations/probe", {
      headers: {
        authorization: `Bearer ${bearerFor("customer-1301", "platform-secret-123")}`,
        "x-platform-user-id": "user_customer_owner",
      },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ clerkUserId: "user_customer_owner" });

    for (const headers of [
      { "x-platform-user-id": "user_stranger" },
      { "x-platform-user-id": "user_customer_owner", "x-platform-verified": "" },
      { "x-platform-user-id": "user_customer_owner", "x-platform-verified": "invalid" },
    ]) {
      const rejected = await app.request("/internal/containers/customer-1301/integrations/probe", {
        headers: {
          authorization: `Bearer ${bearerFor("customer-1301", "platform-secret-123")}`,
          ...headers,
        },
      });
      expect(rejected.status).toBe(401);
    }
  });

  it("rejects unsigned owner headers on shared machines and all preview integrations", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001302",
      clerkUserId: "user_customer_owner",
      handle: "customer-1302",
      runtimeSlot: "main",
      provisioningClass: "customer",
      accessClerkUserIds: ["user_collaborator"],
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001303",
      clerkUserId: "user_preview_owner",
      handle: "pr-1303",
      runtimeSlot: "pr-1303",
      provisioningClass: "preview",
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const app = createTestApp();
    for (const [handle, owner] of [
      ["customer-1302", "user_customer_owner"],
      ["pr-1303", "user_preview_owner"],
    ]) {
      const res = await app.request(`/internal/containers/${handle}/integrations/probe`, {
        headers: {
          authorization: `Bearer ${bearerFor(handle!, "platform-secret-123")}`,
          "x-platform-user-id": owner!,
        },
      });
      expect(res.status).toBe(handle === 'pr-1303' ? 403 : 401);
    }
  });

  it("rejects a delegated actor who cannot access the Preview machine", async () => {
    await insertUserMachine(db, {
      machineId: "00000000-0000-4000-8000-000000001300",
      clerkUserId: "user_preview_owner",
      handle: "pr-1300",
      runtimeSlot: "pr-1300",
      provisioningClass: "preview",
      accessClerkUserIds: ["user_collaborator"],
      status: "running",
      provisionedAt: "2026-08-22T00:00:00.000Z",
    });
    const res = await createTestApp().request("/internal/containers/pr-1300/integrations/probe", {
      headers: delegatedHeaders("pr-1300", "user_stranger"),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid delegated identity instead of falling back to the machine owner", async () => {
    const res = await createTestApp().request("/internal/containers/alice/integrations/probe", {
      headers: {
        ...delegatedHeaders("alice", "user_other"),
        "x-platform-verified": "invalid",
      },
    });
    expect(res.status).toBe(401);
  });

  it("does not delegate a personal machine's integrations to another actor", async () => {
    const res = await createTestApp().request("/internal/containers/alice/integrations/probe", {
      headers: delegatedHeaders("alice", "user_collaborator"),
    });
    expect(res.status).toBe(403);
  });
});
