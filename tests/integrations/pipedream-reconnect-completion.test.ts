import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasCompletedIntegrationConnection, parseConnectedIntegrations } from "@matrix-os/contracts";
import { createTestIntegrationDb } from "./native-integration-db-test-helper.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const secret = "pipedream-reconnect-test-signing-secret";
const externalId = "pd_reconnect_owner";
const accountId = "apn_reconnect_gmail";
const scopes = ["read", "send"];

describe("persisted Pipedream reconnect completion", () => {
  let db: PlatformDb;
  let owner: string;
  let app: ReturnType<typeof createIntegrationRoutes>;
  const broadcast = vi.fn();
  const proxyGet = vi.fn();
  const listAccounts = vi.fn(async () => [{ id: accountId, app: "gmail", email: "owner@example.invalid" }]);

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ db } = await createTestIntegrationDb());
    const user = await db.createUser({ clerkId: "reconnect-owner", handle: "reconnectowner", displayName: "Owner", email: "owner@example.invalid", containerId: "reconnect-container", pipedreamExternalId: externalId });
    owner = user.id;
    const pipedream = { createConnectToken: vi.fn(async () => ({ token: "synthetic-connect-token", expiresAt: "2026-12-31T00:00:00Z" })),
      getOAuthUrl: vi.fn(() => "https://pipedream.com/connect/synthetic"), listAccounts, proxyGet,
      getAppInfo: vi.fn(async () => null), discoverActions: vi.fn(async () => []) } as unknown as PipedreamConnectClient;
    app = createIntegrationRoutes({ db, pipedream, webhookSecret: secret, resolveUserId: async () => owner, broadcast });
  });
  afterEach(async () => { await db.destroy(); });

  function callback(overrides: Record<string, unknown> = {}, validSignature = true) {
    const body = JSON.stringify({ external_user_id: externalId, account_id: accountId, app: "gmail", label: "Work", email: "owner@example.invalid", scopes, ...overrides });
    return app.request("/webhook/connected", { method: "POST", body, headers: { "Content-Type": "application/json",
      "x-pd-signature": validSignature ? createHmac("sha256", secret).update(body).digest("hex") : "0".repeat(64) } });
  }
  async function inventory(path = "/") {
    const response = await app.request(path, path === "/sync" ? { method: "POST" } : undefined);
    expect(response.status).toBe(200);
    return parseConnectedIntegrations(await response.json());
  }

  it("advances successful same-account upserts by at least one JavaScript millisecond without replacing account metadata", async () => {
    const input = { userId: owner, service: "gmail", pipedreamAccountId: accountId, accountLabel: "Work", accountEmail: "owner@example.invalid", scopes };
    const original = await db.connectService(input);
    await db.updateAccountLabel(original.id, "Finance Inbox");
    let previousTime = original.connected_at.getTime();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await db.connectService({ ...input, accountLabel: "Provider default" });
      expect(row.id).toBe(original.id);
      expect(row.inserted).toBe(false);
      expect(row.account_label).toBe("Finance Inbox");
      expect(row.scopes).toEqual(scopes);
      expect(row.connected_at.getTime()).toBeGreaterThanOrEqual(previousTime + 1);
      previousTime = row.connected_at.getTime();
    }
  });

  it("completes an active same-ID reconnect through a signed webhook and the actual sync response", async () => {
    expect((await callback()).status).toBe(200);
    const before = await inventory();
    await db.updateAccountLabel(before[0]!.id, "Finance Inbox");
    const connect = await app.request("/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "gmail", connectionMethod: "pipedream" }) });
    expect(connect.status).toBe(200);
    expect((await callback({ label: "Provider default" })).status).toBe(200);
    const after = await inventory("/sync");
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.accountLabel).toBe("Finance Inbox");
    expect((await db.getConnectedService(after[0]!.id))!.scopes).toEqual(scopes);
    expect(hasCompletedIntegrationConnection(before, "gmail", after)).toBe(true);
    // Repeated admitted notifications update metadata; they do not issue another connection event or action grant.
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("does not advance connection time or complete reconnect from unchanged sync inventory or an unsigned callback", async () => {
    expect((await callback()).status).toBe(200);
    const before = await inventory();
    expect((await callback({}, false)).status).toBe(401);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const after = await inventory("/sync");
      expect(after[0]!.connectedAt).toBe(before[0]!.connectedAt);
      expect(hasCompletedIntegrationConnection(before, "gmail", after)).toBe(false);
    }
    expect(proxyGet).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated service and owner callbacks out of the current Gmail attempt", async () => {
    expect((await callback()).status).toBe(200);
    const before = await inventory();
    expect((await callback({ account_id: "apn_other_service", app: "github" })).status).toBe(200);
    const other = await db.createUser({ clerkId: "reconnect-other", handle: "reconnectother", displayName: "Other", email: "other@example.invalid", containerId: "other-container", pipedreamExternalId: "pd_reconnect_other" });
    expect((await callback({ external_user_id: "pd_reconnect_other" })).status).toBe(200);
    expect((await callback({ external_user_id: "pd_reconnect_other" })).status).toBe(200);
    expect(await db.listConnectedServices(other.id)).toHaveLength(1);
    const after = await inventory("/sync");
    expect(hasCompletedIntegrationConnection(before, "gmail", after)).toBe(false);
  });
});
