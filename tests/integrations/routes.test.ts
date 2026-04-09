import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { createPlatformDb, type PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { getService } from "../../packages/gateway/src/integrations/registry.js";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPipedream(overrides?: Partial<PipedreamConnectClient>): PipedreamConnectClient {
  return {
    createConnectToken: vi.fn().mockResolvedValue({ token: "pd_tok_abc", expiresAt: "2026-12-31T00:00:00Z" }),
    getOAuthUrl: vi.fn().mockReturnValue("https://pipedream.com/connect/test?token=pd_tok_abc&app=gmail"),
    callAction: vi.fn().mockResolvedValue({ messages: [{ id: "1", subject: "Hello" }] }),
    discoverActions: vi.fn().mockResolvedValue([]),
    runAction: vi.fn().mockResolvedValue({ exports: { $summary: "Done" }, ret: { ok: true } }),
    revokeAccount: vi.fn().mockResolvedValue(undefined),
    listAccounts: vi.fn().mockResolvedValue([]),
    getAppInfo: vi.fn().mockResolvedValue(null),
    proxyGet: vi.fn().mockResolvedValue({ messages: [{ id: "1", subject: "Hello" }] }),
    proxyPost: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

const WEBHOOK_SECRET = "whsec_test_secret_123";

describe("Integration Routes", () => {
  let db: PlatformDb;
  let pglite: InstanceType<typeof KyselyPGlite>;
  let pipedream: ReturnType<typeof mockPipedream>;
  let app: Hono;
  let userId: string;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = createPlatformDb({ dialect: pglite.dialect });
    await db.migrate();

    pipedream = mockPipedream();

    const routes = createIntegrationRoutes({
      db,
      pipedream,
      webhookSecret: WEBHOOK_SECRET,
      resolveUserId: async (c) => userId,
    });
    app = new Hono();
    app.route("/api/integrations", routes);

    const user = await db.createUser({
      clerkId: "clerk_route_test",
      handle: "routeuser",
      displayName: "Route User",
      email: "route@example.com",
      containerId: "container_route",
      pipedreamExternalId: "pd_ext_route",
    });
    userId = user.id;
  });

  afterEach(async () => {
    await db.destroy();
  });

  // -----------------------------------------------------------------------
  // GET /api/integrations/available
  // -----------------------------------------------------------------------

  describe("GET /available", () => {
    it("returns the service registry (public, no auth needed)", async () => {
      const res = await app.request("/api/integrations/available");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(6);
      const gmail = data.find((s: any) => s.id === "gmail");
      expect(gmail).toBeDefined();
      expect(gmail.name).toBe("Gmail");
      expect(gmail.actions).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/integrations
  // -----------------------------------------------------------------------

  describe("GET /", () => {
    it("returns empty array when no services connected", async () => {
      const res = await app.request("/api/integrations");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    it("returns connected services for the user", async () => {
      await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_1",
        accountLabel: "Work Gmail",
        accountEmail: "work@gmail.com",
        scopes: ["read", "send"],
      });

      const res = await app.request("/api/integrations");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].service).toBe("gmail");
      expect(data[0].account_label).toBe("Work Gmail");
    });

    it("returns 401 when no user resolved", async () => {
      userId = null as any;
      const res = await app.request("/api/integrations");
      expect(res.status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/integrations/connect
  // -----------------------------------------------------------------------

  describe("POST /connect", () => {
    it("returns an OAuth URL for a valid service", async () => {
      const res = await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", label: "Work Gmail" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.url).toContain("pipedream.com/connect");
      expect(data.service).toBe("gmail");
      expect(pipedream.createConnectToken).toHaveBeenCalled();
    });

    it("rejects unknown service", async () => {
      const res = await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "nonexistent" }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/unknown service/i);
    });

    it("rejects missing service field", async () => {
      const res = await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 401 when no user resolved", async () => {
      userId = null as any;
      const res = await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail" }),
      });
      expect(res.status).toBe(401);
    });

    it("persists fallback pipedream_external_id so the first webhook can resolve the user", async () => {
      const firstConnectUser = await db.createUser({
        clerkId: "clerk_route_first_connect",
        handle: "route-first-connect",
        displayName: "Route First Connect",
        email: "first-connect@example.com",
        containerId: "container_route_first_connect",
      });
      userId = firstConnectUser.id;

      const connectRes = await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", label: "First Connect" }),
      });
      expect(connectRes.status).toBe(200);

      const persisted = await db.getUserById(userId);
      expect(persisted?.pipedream_external_id).toBe(userId);

      const payload = JSON.stringify({
        external_user_id: userId,
        account_id: "pd_acc_first_connect",
        app: "gmail",
        email: "first@example.com",
      });
      const signature = signPayload(payload, WEBHOOK_SECRET);
      const webhookRes = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": signature,
        },
        body: payload,
      });
      expect(webhookRes.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/integrations/webhook/connected
  // -----------------------------------------------------------------------

  describe("POST /webhook/connected", () => {
    it("creates a connected service on valid webhook", async () => {
      const payload = JSON.stringify({
        external_user_id: "pd_ext_route",
        account_id: "pd_acc_webhook",
        app: "gmail",
        label: "Webhook Gmail",
        email: "webhook@gmail.com",
        scopes: ["read"],
      });
      const signature = signPayload(payload, WEBHOOK_SECRET);

      const res = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": signature,
        },
        body: payload,
      });
      expect(res.status).toBe(200);

      const services = await db.listConnectedServices(userId);
      expect(services).toHaveLength(1);
      expect(services[0].service).toBe("gmail");
      expect(services[0].pipedream_account_id).toBe("pd_acc_webhook");
    });

    it("rejects invalid HMAC signature", async () => {
      const payload = JSON.stringify({
        external_user_id: "pd_ext_route",
        account_id: "pd_acc_bad",
        app: "gmail",
      });

      const res = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": "invalid_sig",
        },
        body: payload,
      });
      expect(res.status).toBe(401);
    });

    it("rejects signatures with extra trailing bytes", async () => {
      const payload = JSON.stringify({
        external_user_id: "pd_ext_route",
        account_id: "pd_acc_bad_suffix",
        app: "gmail",
      });

      const res = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": `${signPayload(payload, WEBHOOK_SECRET)}garbage`,
        },
        body: payload,
      });
      expect(res.status).toBe(401);
    });

    it("rejects missing signature header", async () => {
      const payload = JSON.stringify({
        external_user_id: "pd_ext_route",
        account_id: "pd_acc_nosig",
        app: "gmail",
      });

      const res = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 when external user not found", async () => {
      const payload = JSON.stringify({
        external_user_id: "nonexistent_user",
        account_id: "pd_acc_x",
        app: "gmail",
      });
      const signature = signPayload(payload, WEBHOOK_SECRET);

      const res = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": signature,
        },
        body: payload,
      });
      expect(res.status).toBe(400);
    });

    it("assigns distinct pending labels for back-to-back same-service connects", async () => {
      await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", label: "Work Gmail" }),
      });
      await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", label: "Personal Gmail" }),
      });

      const workPayload = JSON.stringify({
        external_user_id: "pd_ext_route",
        account_id: "pd_acc_work_pending",
        app: "gmail",
      });
      const personalPayload = JSON.stringify({
        external_user_id: "pd_ext_route",
        account_id: "pd_acc_personal_pending",
        app: "gmail",
      });

      const workRes = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": signPayload(workPayload, WEBHOOK_SECRET),
        },
        body: workPayload,
      });
      expect(workRes.status).toBe(200);

      const personalRes = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": signPayload(personalPayload, WEBHOOK_SECRET),
        },
        body: personalPayload,
      });
      expect(personalRes.status).toBe(200);

      const services = await db.listConnectedServices(userId);
      expect(services).toHaveLength(2);
      expect(services.map((svc) => svc.account_label).sort()).toEqual([
        "Personal Gmail",
        "Work Gmail",
      ]);
    });

    it("does not store Slack usernames in account_email", async () => {
      pipedream.proxyGet = vi.fn().mockImplementation(async (opts: { url: string }) => {
        if (opts.url === "https://slack.com/api/auth.test") {
          return { user: "slack-display-name" };
        }
        return { ok: true };
      });

      const payload = JSON.stringify({
        external_user_id: "pd_ext_route",
        account_id: "pd_acc_slack_email",
        app: "slack",
        label: "Team Slack",
      });
      const res = await app.request("/api/integrations/webhook/connected", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pd-signature": signPayload(payload, WEBHOOK_SECRET),
        },
        body: payload,
      });
      expect(res.status).toBe(200);

      const services = await db.listConnectedServices(userId);
      expect(services).toHaveLength(1);
      expect(services[0].account_email).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/integrations/call
  // -----------------------------------------------------------------------

  describe("POST /call", () => {
    let serviceId: string;

    beforeEach(async () => {
      const svc = await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_call",
        accountLabel: "Call Test",
        scopes: ["read"],
      });
      serviceId = svc.id;
    });

    it("calls the service via Pipedream and returns data", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "list_messages",
          params: { query: "is:unread" },
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data).toBeDefined();
      expect(data.service).toBe("gmail");
      expect(data.action).toBe("list_messages");
      expect(pipedream.proxyGet).toHaveBeenCalled();
    });

    it("returns a generic 501 when an action is not implemented", async () => {
      await db.connectService({
        userId,
        service: "google_drive",
        pipedreamAccountId: "pd_acc_drive_unimplemented",
        accountLabel: "Drive Test",
        scopes: ["read"],
      });

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "google_drive",
          action: "upload_file",
          params: { name: "notes.txt", content: "hello" },
        }),
      });
      expect(res.status).toBe(501);
      const data = await res.json();
      expect(data.error).toBe("Action not available");
      expect(data.error).not.toMatch(/packages\/gateway|registry\.ts|componentKey/);
    });

    it("touches last_used_at on successful call", async () => {
      await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "list_messages",
        }),
      });

      const svc = await db.getConnectedService(serviceId);
      expect(svc!.last_used_at).not.toBeNull();
    });

    it("rejects unknown service", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "fakesvc", action: "do_thing" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects unknown action", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "nonexistent" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when service not connected", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "github", action: "list_repos" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 401 when no user resolved", async () => {
      userId = null as any;
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "list_messages" }),
      });
      expect(res.status).toBe(401);
    });

    it("handles Pipedream 429 rate limit errors (PipedreamError shape)", async () => {
      // Real Pipedream SDK throws PipedreamError { statusCode, rawResponse }
      const rateLimitError = new Error("Rate limited");
      (rateLimitError as any).statusCode = 429;
      (rateLimitError as any).rawResponse = { headers: new Headers({ "retry-after": "45" }) };
      pipedream.proxyGet = vi.fn().mockRejectedValue(rateLimitError);

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "list_messages" }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("45");
      const data = await res.json();
      expect(data.error).toMatch(/rate.?limit/i);
      expect(data.retry_after).toBe(45);
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/integrations/:id/status
  // -----------------------------------------------------------------------

  describe("GET /:id/status", () => {
    it("returns service status for owned connection", async () => {
      const svc = await db.connectService({
        userId,
        service: "slack",
        pipedreamAccountId: "pd_acc_status",
        accountLabel: "Status Test",
        scopes: ["chat:write"],
      });

      const res = await app.request(`/api/integrations/${svc.id}/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("active");
      expect(data.service).toBe("slack");
    });

    it("returns 404 for non-existent connection", async () => {
      const res = await app.request("/api/integrations/00000000-0000-0000-0000-000000000000/status");
      expect(res.status).toBe(404);
    });

    it("returns 403 for connection owned by another user", async () => {
      const otherUser = await db.createUser({
        clerkId: "clerk_other",
        handle: "otheruser",
        displayName: "Other",
        email: "other@example.com",
        containerId: "container_other",
      });
      const svc = await db.connectService({
        userId: otherUser.id,
        service: "gmail",
        pipedreamAccountId: "pd_acc_other",
        accountLabel: "Other Gmail",
        scopes: [],
      });

      const res = await app.request(`/api/integrations/${svc.id}/status`);
      expect(res.status).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /api/integrations/:id
  // -----------------------------------------------------------------------

  describe("DELETE /:id", () => {
    it("disconnects a service and revokes Pipedream credentials", async () => {
      const svc = await db.connectService({
        userId,
        service: "github",
        pipedreamAccountId: "pd_acc_del",
        accountLabel: "Delete Test",
        scopes: ["repo"],
      });

      const res = await app.request(`/api/integrations/${svc.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(pipedream.revokeAccount).toHaveBeenCalledWith("pd_acc_del");

      const found = await db.getConnectedService(svc.id);
      expect(found!.status).toBe("revoked");
    });

    it("returns 404 for non-existent connection", async () => {
      const res = await app.request("/api/integrations/00000000-0000-0000-0000-000000000000", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when user does not own the connection", async () => {
      const otherUser = await db.createUser({
        clerkId: "clerk_other_del",
        handle: "otherdel",
        displayName: "Other Del",
        email: "otherdel@example.com",
        containerId: "container_other_del",
      });
      const svc = await db.connectService({
        userId: otherUser.id,
        service: "slack",
        pipedreamAccountId: "pd_acc_other_del",
        accountLabel: "Other Slack",
        scopes: [],
      });

      const res = await app.request(`/api/integrations/${svc.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });

    it("returns 502 and keeps the local row when revokeAccount fails", async () => {
      const svc = await db.connectService({
        userId,
        service: "github",
        pipedreamAccountId: "pd_acc_revoke_fail",
        accountLabel: "Revoke Fail",
        scopes: ["repo"],
      });
      const upstreamErr = new Error("Internal Server Error");
      (upstreamErr as any).statusCode = 500;
      pipedream.revokeAccount = vi.fn().mockRejectedValue(upstreamErr);

      const res = await app.request(`/api/integrations/${svc.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(502);

      // Local row must remain active so the user can retry
      const found = await db.getConnectedService(svc.id);
      expect(found!.status).toBe("active");
    });

    it("disconnects locally when revokeAccount returns 404 (already gone upstream)", async () => {
      const svc = await db.connectService({
        userId,
        service: "github",
        pipedreamAccountId: "pd_acc_revoke_404",
        accountLabel: "Revoke 404",
        scopes: ["repo"],
      });
      const goneErr = new Error("Not Found");
      (goneErr as any).statusCode = 404;
      pipedream.revokeAccount = vi.fn().mockRejectedValue(goneErr);

      const res = await app.request(`/api/integrations/${svc.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const found = await db.getConnectedService(svc.id);
      expect(found!.status).toBe("revoked");
    });
  });

  // -----------------------------------------------------------------------
  // POST /api/integrations/:id/refresh
  // -----------------------------------------------------------------------

  describe("POST /:id/refresh", () => {
    it("triggers a token refresh and returns updated status", async () => {
      const svc = await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_refresh",
        accountLabel: "Refresh Test",
        scopes: ["read"],
      });

      const res = await app.request(`/api/integrations/${svc.id}/refresh`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("active");
    });

    it("returns 404 for non-existent connection", async () => {
      const res = await app.request("/api/integrations/00000000-0000-0000-0000-000000000000/refresh", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    it("returns 403 when user does not own the connection", async () => {
      const otherUser = await db.createUser({
        clerkId: "clerk_other_ref",
        handle: "otherref",
        displayName: "Other Ref",
        email: "otherref@example.com",
        containerId: "container_other_ref",
      });
      const svc = await db.connectService({
        userId: otherUser.id,
        service: "gmail",
        pipedreamAccountId: "pd_acc_other_ref",
        accountLabel: "Other Gmail Ref",
        scopes: [],
      });

      const res = await app.request(`/api/integrations/${svc.id}/refresh`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
    });
  });

  // -----------------------------------------------------------------------
  // Input validation
  // -----------------------------------------------------------------------

  describe("Input validation", () => {
    it("rejects invalid JSON body on POST /connect", async () => {
      const res = await app.request("/api/integrations/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body on POST /call", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 5: Enhanced call validation
  // -----------------------------------------------------------------------

  describe("POST /call -- param validation", () => {
    beforeEach(async () => {
      await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_val",
        accountLabel: "Validation Test",
        scopes: ["read", "send"],
      });
      // After R2, /call's "neither componentKey nor directApi" fall-through
      // returns 501 instead of proxying to a fabricated URL. These tests
      // exercise the 200 path via send_email, which in prod gets componentKey
      // populated by discoverComponentKeys() at startup. The mock pipedream
      // here returns [] from discoverActions, so we populate the key by hand
      // to mirror the prod-after-discovery state. Cleaned up in afterEach to
      // avoid state leaking between describe blocks (registry is a module
      // singleton).
      const gmail = getService("gmail")!;
      gmail.actions.send_email.componentKey = "gmail-send-email";
    });

    afterEach(() => {
      const gmail = getService("gmail")!;
      for (const action of Object.values(gmail.actions)) {
        action.componentKey = undefined;
      }
    });

    it("rejects missing required params for an action", async () => {
      // send_email requires to, subject, body
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "send_email",
          params: { to: "alice@example.com" },
          // missing subject and body
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/required/i);
      expect(data.missing).toBeDefined();
      expect(data.missing).toContain("subject");
      expect(data.missing).toContain("body");
    });

    it("accepts call with all required params", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "send_email",
          params: { to: "a@b.com", subject: "Hi", body: "Hello" },
        }),
      });
      expect(res.status).toBe(200);
    });

    it("accepts call with no params when action has no required params", async () => {
      // list_labels has no required params
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "list_labels",
        }),
      });
      expect(res.status).toBe(200);
    });

    it("rejects param with wrong type", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "list_messages",
          params: { maxResults: "not_a_number" },
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/type/i);
    });
  });

  describe("POST /call -- unconnected service error", () => {
    it("includes connect hint when service is not connected", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "github", action: "list_repos" }),
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("not connected");
      expect(data.connect_hint).toBeDefined();
      expect(data.connect_hint).toMatch(/connect/i);
    });
  });

  describe("POST /call -- rate limiting", () => {
    beforeEach(async () => {
      await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_rl",
        accountLabel: "Rate Limit Test",
        scopes: ["read"],
      });
    });

    it("returns 429 with Retry-After header on rate limit (PipedreamError shape)", async () => {
      const rateLimitError = new Error("Rate limited");
      (rateLimitError as any).statusCode = 429;
      (rateLimitError as any).rawResponse = { headers: new Headers({ "retry-after": "30" }) };
      pipedream.proxyGet = vi.fn().mockRejectedValue(rateLimitError);

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "list_messages" }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("30");
      const data = await res.json();
      expect(data.error).toMatch(/rate.?limit/i);
      expect(data.retry_after).toBe(30);
    });

    it("returns default Retry-After when not provided by upstream", async () => {
      const rateLimitError = new Error("Rate limited");
      (rateLimitError as any).statusCode = 429;
      pipedream.proxyGet = vi.fn().mockRejectedValue(rateLimitError);

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "list_messages" }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
      const data = await res.json();
      expect(data.retry_after).toBe(60);
    });
  });

  describe("POST /call -- Pipedream down", () => {
    beforeEach(async () => {
      await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_down",
        accountLabel: "Down Test",
        scopes: ["read"],
      });
    });

    it("returns 503 when Pipedream is unreachable", async () => {
      pipedream.proxyGet = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "list_messages" }),
      });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toMatch(/unavailable/i);
    });

    it("returns 504 on timeout", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "AbortError";
      pipedream.proxyGet = vi.fn().mockRejectedValue(timeoutErr);

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "list_messages" }),
      });
      expect(res.status).toBe(504);
      const data = await res.json();
      expect(data.error).toMatch(/timed?\s*out|timeout/i);
    });

    it("returns 502 for other Pipedream errors", async () => {
      const err = new Error("Internal server error");
      (err as any).statusCode = 500;
      pipedream.proxyGet = vi.fn().mockRejectedValue(err);

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "gmail", action: "list_messages" }),
      });
      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data.error).toMatch(/failed/i);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 10C: POST /call with Actions API (runAction)
  // -----------------------------------------------------------------------

  describe("POST /call -- Actions API (runAction)", () => {
    beforeEach(async () => {
      await db.connectService({
        userId,
        service: "gmail",
        pipedreamAccountId: "pd_acc_actions",
        accountLabel: "Actions Test",
        scopes: ["read", "send"],
      });

      // Simulate discovered component key
      const gmail = getService("gmail")!;
      gmail.actions.send_email.componentKey = "gmail-send-email";
      gmail.actions.list_messages.componentKey = "gmail-list-messages";
    });

    afterEach(() => {
      // Clean up componentKeys
      const gmail = getService("gmail")!;
      for (const action of Object.values(gmail.actions)) {
        action.componentKey = undefined;
      }
    });

    it("uses runAction when componentKey is available", async () => {
      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "send_email",
          params: { to: "alice@example.com", subject: "Hi", body: "Hello" },
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data).toBeDefined();
      expect(data.summary).toBe("Done");
      expect(pipedream.runAction).toHaveBeenCalledWith(
        expect.objectContaining({
          externalUserId: expect.any(String),
          componentKey: "gmail-send-email",
          configuredProps: expect.objectContaining({
            gmail: { authProvisionId: "pd_acc_actions" },
            to: "alice@example.com",
            subject: "Hi",
            body: "Hello",
          }),
        }),
      );
      // Should NOT have used the proxy
      expect(pipedream.callAction).not.toHaveBeenCalled();
    });

    it("falls back to directApi when no componentKey discovered", async () => {
      // list_labels has directApi set but no componentKey
      const gmail = getService("gmail")!;
      gmail.actions.list_labels.componentKey = undefined;

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "list_labels",
        }),
      });
      expect(res.status).toBe(200);
      expect(pipedream.proxyGet).toHaveBeenCalled();
      expect(pipedream.runAction).not.toHaveBeenCalled();
    });

    it("returns summary from action exports", async () => {
      (pipedream.runAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        exports: { $summary: "Email sent to alice@example.com" },
        ret: { messageId: "msg_123" },
      });

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "send_email",
          params: { to: "alice@example.com", subject: "Hi", body: "Hello" },
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.summary).toBe("Email sent to alice@example.com");
      expect(data.data).toEqual({ messageId: "msg_123" });
    });

    it("handles runAction errors with proper status codes", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "AbortError";
      (pipedream.runAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(timeoutErr);

      const res = await app.request("/api/integrations/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service: "gmail",
          action: "send_email",
          params: { to: "a@b.com", subject: "X", body: "Y" },
        }),
      });
      expect(res.status).toBe(504);
    });
  });
});
