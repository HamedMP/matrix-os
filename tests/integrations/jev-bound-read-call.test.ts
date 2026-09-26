import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";

const binding = { service: "gmail", accountLabel: "My Gmail", connectionId: "conn_fixture", expectedEmail: "me@example.test" };
function fixture(mode = "valid") {
  const row = { id: "conn_fixture", user_id: "owner_fixture", service: "gmail", status: "active",
    account_label: "My Gmail", account_email: "me@example.test", pipedream_account_id: "apn_fixture" };
  const boundedGmailGet = vi.fn(async (input: { kind: string }) => input.kind === "profile"
    ? { emailAddress: mode === "wrong-profile" ? "other@example.test" : "me@example.test" }
    : { id: "thread_fixture", messages: [{ id: "message_fixture" }] });
  const proxyGet = vi.fn();
  const db = { listConnectedServices: vi.fn(async () => mode === "missing" ? []
    : mode === "duplicate" ? [row, { ...row, id: "other_connection" }]
      : [{ ...row, ...(mode === "wrong-owner" ? { user_id: "other_owner" } : {}),
        ...(mode === "revoked" ? { status: "revoked" } : {}),
        ...(mode === "swapped-account" ? { id: "changed_connection" } : {}) }]),
  getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_owner_fixture" })), touchServiceUsage: vi.fn() };
  const app = new Hono();
  app.route("/api/integrations", createIntegrationReadCallRoutes({ db: db as unknown as PlatformDb,
    pipedream: { boundedGmailGet, proxyGet } as unknown as PipedreamConnectClient, resolveUserId: async () => "owner_fixture" }));
  const call = (action = "get_thread_ids", params: unknown = { threadId: "thread_fixture" }) =>
    app.request("/api/integrations/read-call", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "gmail", action, label: "My Gmail", params, binding }) });
  return { call, boundedGmailGet, proxyGet };
}

describe("recipe-pinned Platform read-call", () => {
  it("uses the selected owner's same account and matches live profile before the requested bounded read", async () => {
    const { call, boundedGmailGet, proxyGet } = fixture();
    expect((await call()).status).toBe(200);
    expect(boundedGmailGet.mock.calls.map(([input]) => input.kind)).toEqual(["profile", "thread-ids"]);
    expect(boundedGmailGet).toHaveBeenNthCalledWith(1, { kind: "profile", externalUserId: "pd_owner_fixture", accountId: "apn_fixture" }, expect.any(AbortSignal));
    expect(proxyGet).not.toHaveBeenCalled();
  });
  it.each(["wrong-owner", "missing", "duplicate", "revoked", "swapped-account", "wrong-profile"])("denies %s before any requested mailbox read", async (mode) => {
    const { call, boundedGmailGet, proxyGet } = fixture(mode);
    expect((await call()).status).not.toBe(200);
    expect(boundedGmailGet.mock.calls.filter(([input]) => input.kind !== "profile")).toHaveLength(0);
    expect(boundedGmailGet).toHaveBeenCalledTimes(mode === "wrong-profile" ? 1 : 0);
    expect(proxyGet).not.toHaveBeenCalled();
  });
  it.each(["send_email", "list_labels", "history_list"])("denies out-of-workflow %s without any provider call", async (action) => {
    const { call, boundedGmailGet, proxyGet } = fixture();
    expect((await call(action, {})).status).not.toBe(200);
    expect(boundedGmailGet).not.toHaveBeenCalled();
    expect(proxyGet).not.toHaveBeenCalled();
  });
});
