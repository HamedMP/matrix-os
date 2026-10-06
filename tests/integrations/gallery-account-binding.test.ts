import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import { createIntegrationBridgeRoutes } from "../../packages/gateway/src/integrations/bridge-routes.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const accountBinding = { service: "gmail", accountLabel: "Personal", connectionId: "selected_connection", expectedEmail: "selected@example.test" };
function fixture(changes: Record<string, unknown> = {}) {
  const row = { id: "selected_connection", user_id: "owner", service: "gmail", status: "active",
    account_label: "Personal", account_email: "selected@example.test", pipedream_account_id: "provider_selected", ...changes };
  const proxyGet = vi.fn(async () => ({ labels: [] }));
  const db = { listConnectedServices: vi.fn(async () => [row]), getUserById: vi.fn(async () => ({ pipedream_external_id: "provider_owner" })), touchServiceUsage: vi.fn() };
  const app = new Hono();
  app.route("/api/integrations", createIntegrationReadCallRoutes({ db: db as unknown as PlatformDb,
    pipedream: { proxyGet } as unknown as PipedreamConnectClient, resolveUserId: async () => "owner" }));
  const call = (extra: Record<string, unknown> = { accountBinding }) => app.request("/api/integrations/read-call", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "gmail", action: "list_labels", label: "Personal", params: {}, ...extra }),
  });
  return { call, proxyGet };
}
describe("gallery immutable account snapshots", () => {
  it("exposes immutable identity metadata without exposing provider credentials", async () => {
    const app = createIntegrationBridgeRoutes({
      platformDb: { listConnectedServices: async () => [{ id: "selected_connection", service: "gmail",
        account_label: "Personal", account_email: "selected@example.test", status: "active",
        pipedream_account_id: "private_provider_id", access_token: "private_token" }] } as unknown as PlatformDb,
      pipedream: null, resolveUserId: async () => "owner",
    });
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ services: [{ id: "selected_connection", service: "gmail",
      account_label: "Personal", account_email: "selected@example.test", status: "active" }] });
  });
  it("reads only the selected account through the independent binding", async () => {
    const { call, proxyGet } = fixture();
    expect((await call()).status).toBe(200);
    expect(proxyGet).toHaveBeenCalledWith(expect.objectContaining({ accountId: "provider_selected" }));
  });
  it.each([
    { id: "replacement_connection" }, { account_email: "replacement@example.test" },
    { user_id: "another_owner" }, { status: "revoked" },
  ])("rejects changed identity %j before any provider read", async changes => {
    const { call, proxyGet } = fixture(changes);
    expect((await call()).status).toBe(403);
    expect(proxyGet).not.toHaveBeenCalled();
  });
  it("retains an explicit null email snapshot for accounts without email", async () => {
    const { call, proxyGet } = fixture({ account_email: null });
    expect((await call({ accountBinding: { ...accountBinding, expectedEmail: null } })).status).toBe(200);
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...accountBinding, service: "github" }, { ...accountBinding, accountLabel: "Work" },
  ])("denies inconsistent request bindings %j", async binding => {
    const { call, proxyGet } = fixture();
    expect((await call({ accountBinding: binding })).status).toBe(403);
    expect(proxyGet).not.toHaveBeenCalled();
  });
  it.each([
    { ...accountBinding, connectionId: "" }, { ...accountBinding, expectedEmail: undefined },
    { ...accountBinding, expectedEmail: "x".repeat(321) }, { ...accountBinding, token: "credential" },
  ])("rejects malformed or credential-bearing bindings %j", async binding => {
    const { call, proxyGet } = fixture();
    expect((await call({ accountBinding: binding })).status).toBe(400);
    expect(proxyGet).not.toHaveBeenCalled();
  });
  it("keeps legacy unbound reads compatible", async () => {
    const { call, proxyGet } = fixture();
    expect((await call({})).status).toBe(200);
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });
  it("requires a binding for gallery import reads and rejects combined Jev bindings", async () => {
    const { call, proxyGet } = fixture();
    expect((await call({ galleryImport: true })).status).toBe(400);
    expect((await call({ galleryImport: true, accountBinding })).status).toBe(200);
    expect((await call({ accountBinding, binding: accountBinding })).status).toBe(400);
    expect(proxyGet).toHaveBeenCalledTimes(1);
  });
});
