import { describe, expect, it, vi } from "vitest";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const owner = "owner_selected_call";
const params = { to: "recipient@example.invalid", subject: "Test", body: "Test" };
function setup(rows = [{ id: "conn_work", service: "gmail", account_label: "Work", pipedream_account_id: "apn_work" }]) {
  const proxyPost = vi.fn(async () => ({ id: "sent" }));
  const listAccounts = vi.fn(async () => []);
  const getUserById = vi.fn(async () => ({ pipedream_external_id: "pd_owner" }));
  const db = { listConnectedServices: vi.fn(async (userId: string) => { expect(userId).toBe(owner); return rows; }), getUserById, touchServiceUsage: vi.fn() } as unknown as PlatformDb;
  const provider = { proxyPost, listAccounts, getAppInfo: vi.fn(async () => null) } as unknown as PipedreamConnectClient;
  const app = createIntegrationRoutes({ db, pipedream: provider, webhookSecret: "test-only", resolveUserId: async () => owner });
  const call = (input: Record<string, unknown>) => app.request("/call", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "gmail", action: "send_email", label: "Work", params, ...input }) });
  return { app, db, provider, proxyPost, listAccounts, getUserById, call };
}

describe("immutable selected account on general integration calls", () => {
  it.each(["deleted-source", "other-owner-source"])("rejects wrong selected ID %s before a write or account synchronization", async connectionId => {
    const fixture = setup();
    expect((await fixture.call({ connectionId })).status).toBe(403);
    expect(fixture.proxyPost).not.toHaveBeenCalled();
    expect(fixture.listAccounts).not.toHaveBeenCalled();
    expect(fixture.getUserById).not.toHaveBeenCalled();
  });

  it("does not synchronize a missing immutable account to a replacement", async () => {
    const fixture = setup([]);
    expect((await fixture.call({ connectionId: "conn_work" })).status).toBe(403);
    expect(fixture.proxyPost).not.toHaveBeenCalled();
    expect(fixture.listAccounts).not.toHaveBeenCalled();
    expect(fixture.getUserById).not.toHaveBeenCalled();
  });

  it.each(["", "../account", "a".repeat(129), 123])("rejects malformed connection ID %s at the route boundary", async connectionId => {
    const fixture = setup();
    expect((await fixture.call({ connectionId })).status).toBe(400);
    expect(fixture.proxyPost).not.toHaveBeenCalled();
    expect(fixture.db.listConnectedServices).not.toHaveBeenCalled();
  });

  it.each([{}, { connectionId: "conn_work" }])("retains legacy label calls and allows a matching immutable account %s", async input => {
    const fixture = setup();
    expect((await fixture.call(input)).status).toBe(200);
    expect(fixture.proxyPost).toHaveBeenCalledWith(expect.objectContaining({ externalUserId: "pd_owner", accountId: "apn_work" }));
  });

  it("still permits legacy sync on cache miss when no immutable account was supplied", async () => {
    const fixture = setup([]);
    expect((await fixture.call({})).status).toBe(404);
    expect(fixture.listAccounts).toHaveBeenCalledOnce();
    expect(fixture.proxyPost).not.toHaveBeenCalled();
  });

  it.each(["managed_work", "old-managed", undefined])("binds the managed call's explicit selected account %s", async connectionId => {
    const fixture = setup();
    const call = vi.fn(async () => ({ folders: [] }));
    const managed = createIntegrationRoutes({ db: fixture.db, pipedream: fixture.provider, webhookSecret: "test",
      resolveUserId: async () => owner, mcpPresetBroker: {
        listConnections: vi.fn(async (userId: string) => { expect(userId).toBe(owner); return [{ id: "managed_work", service: "granola", account_label: "Work", status: "active" }]; }), call,
      } as never });
    const response = await managed.request("/call", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "granola", action: "list_folders", label: "Work", ...(connectionId ? { connectionId } : {}) }) });
    expect(response.status).toBe(connectionId === "old-managed" ? 403 : 200);
    if (connectionId === "old-managed") expect(call).not.toHaveBeenCalled();
    else expect(call).toHaveBeenCalledWith(expect.objectContaining({ userId: owner, ...(connectionId ? { connectionId } : {}) }));
  });
});
