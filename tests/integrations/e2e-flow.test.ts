import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { createHmac } from "node:crypto";

const WEBHOOK_SECRET = "whsec_e2e_test";

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

describe("E2E: connect -> call -> disconnect flow", () => {
  let db: PlatformDb;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let pipedream: PipedreamConnectClient;
  let app: Hono;
  let userId: string;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();

    pipedream = {
      createConnectToken: vi.fn().mockResolvedValue({ token: "pd_tok_e2e", expiresAt: "2026-12-31T00:00:00Z" }),
      getOAuthUrl: vi.fn().mockReturnValue("https://pipedream.com/connect/proj?token=pd_tok_e2e&app=gmail"),
      callAction: vi.fn().mockResolvedValue({ messages: [{ id: "msg_1", subject: "Welcome" }] }),
      revokeAccount: vi.fn().mockResolvedValue(undefined),
    };

    const routes = createIntegrationRoutes({
      db,
      pipedream,
      webhookSecret: WEBHOOK_SECRET,
      resolveUserId: async () => userId,
    });
    app = new Hono();
    app.route("/api/integrations", routes);

    const user = await db.createUser({
      clerkId: "clerk_e2e",
      handle: "e2euser",
      displayName: "E2E User",
      email: "e2e@example.com",
      containerId: "container_e2e",
      pipedreamExternalId: "pd_ext_e2e",
    });
    userId = user.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("completes the full connect -> call -> disconnect lifecycle", async () => {
    // Step 1: Check no services connected
    const listBefore = await app.request("/api/integrations");
    expect(listBefore.status).toBe(200);
    expect(await listBefore.json()).toEqual([]);

    // Step 2: Initiate OAuth connect
    const connectRes = await app.request("/api/integrations/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "gmail", label: "Work" }),
    });
    expect(connectRes.status).toBe(200);
    const connectData = await connectRes.json();
    expect(connectData.url).toContain("pipedream.com/connect");
    expect(connectData.service).toBe("gmail");

    // Step 3: Simulate Pipedream webhook (OAuth complete)
    const webhookPayload = JSON.stringify({
      external_user_id: "pd_ext_e2e",
      account_id: "pd_acc_e2e_gmail",
      app: "gmail",
      label: "Work",
      email: "user@gmail.com",
      scopes: ["read", "send"],
    });
    const webhookRes = await app.request("/api/integrations/webhook/connected", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pd-signature": signPayload(webhookPayload, WEBHOOK_SECRET),
      },
      body: webhookPayload,
    });
    expect(webhookRes.status).toBe(200);

    // Step 4: Verify service appears in list
    const listAfter = await app.request("/api/integrations");
    expect(listAfter.status).toBe(200);
    const services = await listAfter.json();
    expect(services).toHaveLength(1);
    expect(services[0].service).toBe("gmail");
    expect(services[0].account_label).toBe("Work");
    expect(services[0].account_email).toBe("user@gmail.com");
    expect(services[0].scopes).toEqual(["read", "send"]);
    const connectionId = services[0].id;

    // Step 5: Check connection status
    const statusRes = await app.request(`/api/integrations/${connectionId}/status`);
    expect(statusRes.status).toBe(200);
    const statusData = await statusRes.json();
    expect(statusData.status).toBe("active");

    // Step 6: Call the service
    const callRes = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "gmail",
        action: "list_messages",
        params: { query: "is:unread" },
      }),
    });
    expect(callRes.status).toBe(200);
    const callData = await callRes.json();
    expect(callData.data.messages).toHaveLength(1);
    expect(callData.service).toBe("gmail");
    expect(callData.action).toBe("list_messages");

    // Step 7: Verify last_used_at was updated
    const svc = await db.getConnectedService(connectionId);
    expect(svc!.last_used_at).not.toBeNull();

    // Step 8: Disconnect
    const disconnectRes = await app.request(`/api/integrations/${connectionId}`, {
      method: "DELETE",
    });
    expect(disconnectRes.status).toBe(200);
    expect(pipedream.revokeAccount).toHaveBeenCalledWith("pd_acc_e2e_gmail");

    // Step 9: Verify disconnected (revoked, no longer in active list)
    const listFinal = await app.request("/api/integrations");
    expect(listFinal.status).toBe(200);
    expect(await listFinal.json()).toEqual([]);

    const disconnected = await db.getConnectedService(connectionId);
    expect(disconnected!.status).toBe("revoked");
  });

  it("handles calling a disconnected service gracefully", async () => {
    // Connect via webhook
    const webhookPayload = JSON.stringify({
      external_user_id: "pd_ext_e2e",
      account_id: "pd_acc_temp",
      app: "slack",
      label: "Team Slack",
      scopes: ["chat:write"],
    });
    await app.request("/api/integrations/webhook/connected", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pd-signature": signPayload(webhookPayload, WEBHOOK_SECRET),
      },
      body: webhookPayload,
    });

    // Get connection ID
    const list = await (await app.request("/api/integrations")).json();
    const connectionId = list[0].id;

    // Disconnect
    await app.request(`/api/integrations/${connectionId}`, { method: "DELETE" });

    // Try to call -- should get 404 with connect hint
    const callRes = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service: "slack", action: "send_message", params: { channel: "#general", text: "hi" } }),
    });
    expect(callRes.status).toBe(404);
    const data = await callRes.json();
    expect(data.connect_hint).toBeDefined();
  });
});

describe("E2E: multi-account flow", () => {
  let db: PlatformDb;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let pipedream: PipedreamConnectClient;
  let app: Hono;
  let userId: string;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();

    let callCount = 0;
    pipedream = {
      createConnectToken: vi.fn().mockResolvedValue({ token: "pd_tok_multi", expiresAt: "2026-12-31T00:00:00Z" }),
      getOAuthUrl: vi.fn().mockReturnValue("https://pipedream.com/connect/proj?token=pd_tok_multi&app=gmail"),
      callAction: vi.fn().mockImplementation(async (opts) => {
        // Return different data based on accountId to verify correct account is used
        if (opts.accountId === "pd_acc_work") {
          return { messages: [{ id: "w1", subject: "Work email" }] };
        }
        return { messages: [{ id: "p1", subject: "Personal email" }] };
      }),
      revokeAccount: vi.fn().mockResolvedValue(undefined),
    };

    const routes = createIntegrationRoutes({
      db,
      pipedream,
      webhookSecret: WEBHOOK_SECRET,
      resolveUserId: async () => userId,
    });
    app = new Hono();
    app.route("/api/integrations", routes);

    const user = await db.createUser({
      clerkId: "clerk_multi",
      handle: "multiuser",
      displayName: "Multi User",
      email: "multi@example.com",
      containerId: "container_multi",
      pipedreamExternalId: "pd_ext_multi",
    });
    userId = user.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("supports multiple accounts for the same service with labels", async () => {
    // Connect Work Gmail
    const workPayload = JSON.stringify({
      external_user_id: "pd_ext_multi",
      account_id: "pd_acc_work",
      app: "gmail",
      label: "Work Gmail",
      email: "work@company.com",
      scopes: ["read", "send"],
    });
    await app.request("/api/integrations/webhook/connected", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pd-signature": signPayload(workPayload, WEBHOOK_SECRET),
      },
      body: workPayload,
    });

    // Connect Personal Gmail
    const personalPayload = JSON.stringify({
      external_user_id: "pd_ext_multi",
      account_id: "pd_acc_personal",
      app: "gmail",
      label: "Personal Gmail",
      email: "me@gmail.com",
      scopes: ["read"],
    });
    await app.request("/api/integrations/webhook/connected", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pd-signature": signPayload(personalPayload, WEBHOOK_SECRET),
      },
      body: personalPayload,
    });

    // List -- should have 2 gmail connections
    const listRes = await app.request("/api/integrations");
    const services = await listRes.json();
    expect(services).toHaveLength(2);
    expect(services.every((s: any) => s.service === "gmail")).toBe(true);

    // Call with Work label -- should use work account
    const workCallRes = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "gmail",
        action: "list_messages",
        label: "Work Gmail",
      }),
    });
    expect(workCallRes.status).toBe(200);
    const workData = await workCallRes.json();
    expect(workData.data.messages[0].subject).toBe("Work email");

    // Verify correct accountId was passed to Pipedream
    const lastCall = (pipedream.callAction as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(lastCall.accountId).toBe("pd_acc_work");

    // Call with Personal label
    const personalCallRes = await app.request("/api/integrations/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: "gmail",
        action: "list_messages",
        label: "Personal Gmail",
      }),
    });
    expect(personalCallRes.status).toBe(200);
    const personalData = await personalCallRes.json();
    expect(personalData.data.messages[0].subject).toBe("Personal email");

    // Disconnect Work -- Personal should still work
    const workId = services.find((s: any) => s.account_label === "Work Gmail").id;
    await app.request(`/api/integrations/${workId}`, { method: "DELETE" });

    const listAfter = await app.request("/api/integrations");
    const remaining = await listAfter.json();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].account_label).toBe("Personal Gmail");
  });
});

describe("E2E: cross-user isolation", () => {
  let db: PlatformDb;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let app: Hono;
  let activeUserId: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();

    const pipedream: PipedreamConnectClient = {
      createConnectToken: vi.fn().mockResolvedValue({ token: "tok", expiresAt: "2026-12-31T00:00:00Z" }),
      getOAuthUrl: vi.fn().mockReturnValue("https://example.com"),
      callAction: vi.fn().mockResolvedValue({ data: "ok" }),
      revokeAccount: vi.fn().mockResolvedValue(undefined),
    };

    const routes = createIntegrationRoutes({
      db,
      pipedream,
      webhookSecret: WEBHOOK_SECRET,
      resolveUserId: async () => activeUserId,
    });
    app = new Hono();
    app.route("/api/integrations", routes);

    const alice = await db.createUser({
      clerkId: "clerk_alice_iso",
      handle: "alice_iso",
      displayName: "Alice",
      email: "alice@example.com",
      containerId: "container_alice_iso",
    });
    aliceId = alice.id;

    const bob = await db.createUser({
      clerkId: "clerk_bob_iso",
      handle: "bob_iso",
      displayName: "Bob",
      email: "bob@example.com",
      containerId: "container_bob_iso",
    });
    bobId = bob.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("users cannot see or access each other's connections", async () => {
    // Alice connects Gmail
    await db.connectService({
      userId: aliceId,
      service: "gmail",
      pipedreamAccountId: "pd_alice_gmail",
      accountLabel: "Alice Gmail",
      scopes: ["read"],
    });

    // Bob connects Slack
    await db.connectService({
      userId: bobId,
      service: "slack",
      pipedreamAccountId: "pd_bob_slack",
      accountLabel: "Bob Slack",
      scopes: ["chat:write"],
    });

    // Alice's view
    activeUserId = aliceId;
    const aliceList = await app.request("/api/integrations");
    const aliceServices = await aliceList.json();
    expect(aliceServices).toHaveLength(1);
    expect(aliceServices[0].service).toBe("gmail");

    // Bob's view
    activeUserId = bobId;
    const bobList = await app.request("/api/integrations");
    const bobServices = await bobList.json();
    expect(bobServices).toHaveLength(1);
    expect(bobServices[0].service).toBe("slack");

    // Bob tries to access Alice's connection
    const aliceConnectionId = aliceServices[0].id;
    const statusRes = await app.request(`/api/integrations/${aliceConnectionId}/status`);
    expect(statusRes.status).toBe(403);

    const deleteRes = await app.request(`/api/integrations/${aliceConnectionId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(403);

    const refreshRes = await app.request(`/api/integrations/${aliceConnectionId}/refresh`, { method: "POST" });
    expect(refreshRes.status).toBe(403);
  });
});
