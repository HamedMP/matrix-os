import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createIntegrationRoutes } from "../../packages/gateway/src/integrations/routes.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const row = (id: string, accountId: string, label: string) => ({
  id, user_id: "owner", service: "gmail", pipedream_account_id: accountId,
  account_label: label, account_email: "same@example.test", scopes: [], status: "active",
  connected_at: "2026-10-25T00:00:00.000Z", last_used_at: null,
  access_token: "must-not-leave-server",
});
const rows = [
  row("11111111-1111-4111-8111-111111111111", "gmail_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Pipedream"),
  row("22222222-2222-4222-8222-222222222222", "apn_testAccount", "Matrix"),
  row("33333333-3333-4333-8333-333333333333", "unrecognized_transport", "Gmail"),
];

function appForOwner(owner: string | null = "owner") {
  const db = {
    listConnectedServices: vi.fn().mockResolvedValue(rows),
    getConnectedService: vi.fn(async (id: string) => rows.find(item => item.id === id)),
    getUserById: vi.fn().mockResolvedValue({ pipedream_external_id: "external-owner" }),
  } as unknown as PlatformDb;
  const pipedream = { getAppInfo: vi.fn().mockResolvedValue(null), listAccounts: vi.fn().mockResolvedValue([]) } as unknown as PipedreamConnectClient;
  const app = new Hono();
  app.route("/api/integrations", createIntegrationRoutes({ db, pipedream, webhookSecret: "test", resolveUserId: async () => owner }));
  return app;
}

describe("authoritative Gmail connection method projection", () => {
  it.each(["list", "sync"])("projects methods and only safe fields from %s", async source => {
    const response = await appForOwner().request(source === "list" ? "/api/integrations" : "/api/integrations/sync", source === "sync" ? { method: "POST" } : undefined);
    expect(response.status).toBe(200);
    const body = await response.json();
    const connections = source === "list" ? body : body.services;
    expect(connections.map((item: { connection_method?: string }) => item.connection_method)).toEqual(["matrix", "pipedream", undefined]);
    expect(connections.map((item: { account_label: string }) => item.account_label)).toEqual(["Pipedream", "Matrix", "Gmail"]);
    expect(JSON.stringify(body)).not.toContain("pipedream_account_id");
    expect(JSON.stringify(body)).not.toContain("must-not-leave-server");
    expect(JSON.stringify(body)).not.toContain("gmail_aaaaaaaa");
    expect(JSON.stringify(body)).not.toContain("apn_testAccount");
  });

  it("keeps the same authoritative method on an owned status read", async () => {
    const response = await appForOwner().request(`/api/integrations/${rows[0].id}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: rows[0].id, connection_method: "matrix" });
  });

  it("does not expose method metadata without an owner", async () => {
    expect((await appForOwner(null).request("/api/integrations")).status).toBe(401);
    expect((await appForOwner("another-owner").request(`/api/integrations/${rows[0].id}/status`)).status).toBe(403);
  });
});
