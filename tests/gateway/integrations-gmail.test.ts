import { describe, expect, it, vi } from "vitest";
import { getAction, getService } from "../../packages/gateway/src/integrations/registry.js";
import { createIntegrationRoutes, executeIntegrationAction, validateActionParams } from "../../packages/gateway/src/integrations/routes.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

function client() {
  return { proxyGet: vi.fn(), proxyPost: vi.fn(), runAction: vi.fn(), listAccounts: vi.fn(), getAppInfo: vi.fn().mockResolvedValue(null) };
}

async function execute(actionId: string, params: Record<string, unknown>, pipedream = client()) {
  const actionDef = getAction("gmail", actionId);
  expect(actionDef).toBeDefined();
  return executeIntegrationAction({
    pipedream: pipedream as unknown as PipedreamConnectClient,
    externalUserId: "owner", connection: { pipedream_account_id: "account" },
    def: getService("gmail")!, actionDef: actionDef!, serviceId: "gmail", actionId, params,
  });
}

describe("Gmail connector foundation", () => {
  it.each(["list_messages", "search"])("paginates %s without changing the query", async (actionId) => {
    const pipedream = client();
    const response = { messages: [{ id: "abc123" }], nextPageToken: "next", resultSizeEstimate: 123 };
    pipedream.proxyGet.mockResolvedValue(response);
    expect(await execute(actionId, { query: "in:inbox", maxResults: 50, pageToken: "opaque+/=" }, pipedream))
      .toEqual({ data: response });
    expect(pipedream.proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      params: { q: "in:inbox", maxResults: "50", pageToken: "opaque+/=" },
    }));
  });

  it("retains optional list/search defaults", async () => {
    expect(validateActionParams(getAction("gmail", "list_messages")!, undefined)).toEqual({ valid: true });
    expect(getAction("gmail", "list_messages")!.directApi!.mapParams!({})).toEqual({});
    expect(getAction("gmail", "search")!.directApi!.mapParams!({ query: "books" })).toEqual({ q: "books" });
  });

  it("preserves history IDs beyond JS safe integers and returns the untouched cursor", async () => {
    const pipedream = client();
    const startHistoryId = "18446744073709551614";
    const response = { history: [{ id: startHistoryId }], historyId: "18446744073709551615", nextPageToken: "next" };
    pipedream.proxyGet.mockResolvedValue(response);
    expect(await execute("list_history", { startHistoryId, pageToken: "page", maxResults: 500 }, pipedream)).toEqual({ data: response });
    expect(pipedream.proxyGet).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/history",
      params: { startHistoryId, pageToken: "page", maxResults: "500" },
    }));
  });

  it("does not mask an expired-history failure as an empty successful page", async () => {
    const pipedream = client();
    const expired = new Error("upstream history expired");
    pipedream.proxyGet.mockRejectedValue(expired);
    await expect(execute("list_history", { startHistoryId: "123" }, pipedream)).rejects.toBe(expired);
  });

  it("creates a label using only the requested name", async () => {
    const pipedream = client();
    await execute("create_label", { name: "Personal/Receipts" }, pipedream);
    expect(pipedream.proxyPost).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/labels", body: { name: "Personal/Receipts" },
    }));
  });

  it("archives and tags exactly one message via labels", async () => {
    const pipedream = client();
    await execute("modify_message", { messageId: "abc123", addLabelIds: ["Label_123"], removeLabelIds: ["INBOX", "UNREAD"] }, pipedream);
    expect(pipedream.proxyPost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123/modify",
      body: { addLabelIds: ["Label_123"], removeLabelIds: ["INBOX", "UNREAD"] },
    }));
  });

  it.each([
    ["list_messages", { maxResults: 0 }], ["list_messages", { maxResults: 501 }],
    ["search", { query: "books", maxResults: 1.5 }], ["list_messages", { maxResults: NaN }],
    ["list_messages", { pageToken: "" }], ["list_messages", { pageToken: "x".repeat(2049) }],
    ["list_messages", { pageToken: "bad\nheader" }], ["list_messages", { query: "x".repeat(4097) }],
    ["get_message", { messageId: "../profile" }], ["get_message", { messageId: "a?format=raw" }],
    ["get_message", { messageId: "" }], ["get_message", { messageId: "x".repeat(129) }],
    ["list_history", { startHistoryId: 9007199254740992 }], ["list_history", { startHistoryId: "1e20" }],
    ["list_history", { startHistoryId: "" }], ["list_history", { startHistoryId: "1".repeat(21) }],
    ["list_history", { startHistoryId: "1", maxResults: 501 }],
    ["create_label", { name: " " }], ["create_label", { name: "x".repeat(101) }],
    ["create_label", { name: "a\nb" }], ["create_label", { name: "Receipts", id: "INBOX" }],
    ["modify_message", { messageId: "abc" }],
    ["modify_message", { messageId: "abc", addLabelIds: [], removeLabelIds: [] }],
    ["modify_message", { messageId: "abc", addLabelIds: ["INBOX"], removeLabelIds: ["INBOX"] }],
    ["modify_message", { messageId: "abc", addLabelIds: ["Label_1", "Label_1"] }],
    ["modify_message", { messageId: "abc", addLabelIds: [null] }],
    ["modify_message", { messageId: "abc", addLabelIds: ["a/b"] }],
    ["modify_message", { messageId: "abc", removeLabelIds: ["TRASH"] }],
    ["modify_message", { messageId: "abc", addLabelIds: ["TRASH"] }],
    ["modify_message", { messageId: "abc", addLabelIds: Array.from({ length: 101 }, (_, i) => `Label_${i}`) }],
    ["modify_message", { messageId: "abc", removeLabelIds: ["INBOX"], ids: ["other"] }],
    ["list_labels", { surprise: true }],
  ] as [string, Record<string, unknown>][])("rejects invalid %s params before any external call: %j", async (actionId, params) => {
    const pipedream = client();
    const action = getAction("gmail", actionId);
    expect(action).toBeDefined();
    expect(validateActionParams(action!, params).valid).toBe(false);
    await expect(execute(actionId, params, pipedream)).rejects.toThrow("Invalid action parameters");
    expect(pipedream.proxyGet).not.toHaveBeenCalled();
    expect(pipedream.proxyPost).not.toHaveBeenCalled();
    expect(pipedream.runAction).not.toHaveBeenCalled();
  });

  it("rejects invalid HTTP actions before connection lookup or Pipedream calls", async () => {
    const pipedream = client();
    const db = { listConnectedServices: vi.fn() };
    const app = createIntegrationRoutes({ db: db as unknown as PlatformDb, pipedream: pipedream as unknown as PipedreamConnectClient,
      webhookSecret: "test", resolveUserId: async () => "owner" });
    const response = await app.request("/call", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "gmail", action: "list_messages", params: { maxResults: 501 } }) });
    expect(response.status).toBe(400);
    expect(db.listConnectedServices).not.toHaveBeenCalled();
    expect(pipedream.listAccounts).not.toHaveBeenCalled();
    expect(pipedream.proxyGet).not.toHaveBeenCalled();
  });

  it("keeps send_email header sanitization and body line breaks", async () => {
    const pipedream = client();
    await execute("send_email", { to: "a@example.com\r\nBcc: b@example.com", subject: "Subject\nBcc: c@example.com",
      cc: "d@example.com\r\nX-Header: evil", body: "First\r\nSecond" }, pipedream);
    const { raw } = pipedream.proxyPost.mock.calls[0][0].body;
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).not.toMatch(/\r\nBcc:|\r\nX-Header:/);
    expect(decoded).toContain("\r\n\r\nFirst\r\nSecond");
    expect(raw).not.toMatch(/[+/=]/);
  });

  it("does not expose delete, trash, or bulk actions", () => {
    expect(Object.keys(getService("gmail")!.actions).join(" ")).not.toMatch(/delete|trash|batch|bulk/);
  });
});
