import { describe, expect, it, vi } from "vitest";
import { MICROSOFT_MAIL_READ_ACTIONS } from "../../packages/gateway/src/integrations/microsoft-mail-reads.js";
import { MICROSOFT_MAIL_REPLY_BYTES } from "../../packages/gateway/src/integrations/microsoft-mail-shared.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction, ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const me = "https://graph.microsoft.com/v1.0/me";
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };
const HTML = { Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"' };
const SUMMARY = "id,conversationId,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isRead,isDraft,flag,hasAttachments,parentFolderId";
const FULL = `${SUMMARY},bccRecipients,replyTo,body`;
const actions = MICROSOFT_MAIL_READ_ACTIONS;

async function run(actionId: string, params: Record<string, unknown>) {
  const proxyGet = vi.fn(async () => ({ value: [] }));
  const action = actions[actionId]!;
  const def = { id: "microsoft_outlook", actions } as unknown as ServiceDefinition;
  const result = await executeIntegrationAction({ pipedream: { proxyGet } as unknown as PipedreamConnectClient,
    externalUserId: "owner", connection: { pipedream_account_id: "account" }, def, actionDef: action,
    serviceId: "microsoft_outlook", actionId, params });
  return { proxyGet, result };
}

type ReadCase = [string, Record<string, unknown>, string, Record<string, string> | undefined, Record<string, string>];
const cases: ReadCase[] = [
  ["get_folder", { folderId: "inbox" }, `${me}/mailFolders/inbox`,
    { $select: "id,displayName,parentFolderId,unreadItemCount,totalItemCount,childFolderCount" }, IMMUTABLE],
  ["get_folder", { folderId: "AAMk+fold=" }, `${me}/mailFolders/AAMk%2Bfold%3D`,
    { $select: "id,displayName,parentFolderId,unreadItemCount,totalItemCount,childFolderCount" }, IMMUTABLE],
  ["list_folder_messages", { folderId: "inbox" }, `${me}/mailFolders/inbox/messages`,
    { $select: SUMMARY, $top: "25", $orderby: "receivedDateTime desc" }, IMMUTABLE],
  ["list_folder_messages", { folderId: "archive", top: 50, skip: 5000, filter: "unread" }, `${me}/mailFolders/archive/messages`,
    { $select: SUMMARY, $top: "50", $skip: "5000", $orderby: "receivedDateTime desc",
      $filter: "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false" }, IMMUTABLE],
  ["list_folder_messages", { folderId: "inbox", filter: "flagged" }, `${me}/mailFolders/inbox/messages`,
    { $select: SUMMARY, $top: "25", $orderby: "receivedDateTime desc",
      $filter: "receivedDateTime ge 1900-01-01T00:00:00Z and flag/flagStatus eq 'flagged'" }, IMMUTABLE],
  ["list_folder_messages", { folderId: "inbox", skip: 0, filter: "attachments" }, `${me}/mailFolders/inbox/messages`,
    { $select: SUMMARY, $top: "25", $skip: "0", $orderby: "receivedDateTime desc",
      $filter: "receivedDateTime ge 1900-01-01T00:00:00Z and hasAttachments eq true" }, IMMUTABLE],
  ["search_messages", { query: "budget" }, `${me}/messages`,
    { $select: SUMMARY, $search: "\"budget\"", $top: "25" }, IMMUTABLE],
  ["search_messages", { query: "say \"hi\" \\ to:ada@example.com", folderId: "sentitems", top: 10, skipToken: "AQ-token_1=" },
    `${me}/mailFolders/sentitems/messages`,
    { $select: SUMMARY, $search: "\"say \\\"hi\\\" \\\\ to:ada@example.com\"", $top: "10", $skiptoken: "AQ-token_1=" }, IMMUTABLE],
  ["list_conversation", { conversationId: "AAQkConv=" }, `${me}/messages`,
    { $filter: "conversationId eq 'AAQkConv='", $select: FULL, $top: "25" }, HTML],
  ["list_conversation", { conversationId: "AAQkConv", top: 5, skip: 500, includeBody: false }, `${me}/messages`,
    { $filter: "conversationId eq 'AAQkConv'", $select: SUMMARY, $top: "5", $skip: "500" }, HTML],
  ["list_conversation", { conversationId: "AAQkConv", includeBody: true }, `${me}/messages`,
    { $filter: "conversationId eq 'AAQkConv'", $select: FULL, $top: "25" }, HTML],
  ["get_message", { messageId: "AAMkMsg-1_=" }, `${me}/messages/AAMkMsg-1_%3D`, { $select: FULL }, HTML],
  ["list_attachments", { messageId: "AAMkMsg" }, `${me}/messages/AAMkMsg/attachments`,
    { $select: "id,name,contentType,size,isInline", $top: "50" }, IMMUTABLE],
  ["get_attachment", { messageId: "AAMkMsg", attachmentId: "AAMkAtt+=" }, `${me}/messages/AAMkMsg/attachments/AAMkAtt%2B%3D`,
    undefined, IMMUTABLE],
];

describe("microsoft_outlook mail reads", () => {
  it("publishes exactly the specified read actions, all read risk with strict schemas", () => {
    expect(Object.keys(actions).sort()).toEqual(["get_attachment", "get_folder", "get_message", "list_attachments",
      "list_conversation", "list_folder_messages", "search_messages"]);
    for (const [id, action] of Object.entries(actions)) {
      expect(action.risk, id).toBe("read");
      expect(action.paramsSchema, id).toBeDefined();
      expect(action.directApi?.method, id).toBe("GET");
      const shape = (action.paramsSchema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(action.params).sort(), id).toEqual(Object.keys(shape).sort());
    }
  });

  it.each(cases)("maps %s to the exact Graph request", async (actionId, params, url, query, headers) => {
    const action: ServiceAction = actions[actionId]!;
    expect(action.paramsSchema!.safeParse(params).success).toBe(true);
    expect(action.paramsSchema!.safeParse({ ...params, arbitraryUrl: "https://evil.example" }).success).toBe(false);
    const { proxyGet, result } = await run(actionId, params);
    expect(result.data).toEqual({ value: [] });
    expect(proxyGet).toHaveBeenCalledTimes(1);
    expect(proxyGet.mock.calls[0]).toEqual([{ externalUserId: "owner", accountId: "account", url, params: query, headers }]);
  });

  const injections = ["", "../x", "inbox/../sentitems", "?q", "inbox?$expand=x", "inbox#f", "\n", "inbox\n", "a b", "it's", "a".repeat(513)];
  const pathParams: [string, string, Record<string, unknown>][] = [
    ["get_folder", "folderId", { folderId: "inbox" }],
    ["list_folder_messages", "folderId", { folderId: "inbox" }],
    ["search_messages", "folderId", { query: "x", folderId: "inbox" }],
    ["list_conversation", "conversationId", { conversationId: "conv" }],
    ["get_message", "messageId", { messageId: "msg" }],
    ["list_attachments", "messageId", { messageId: "msg" }],
    ["get_attachment", "messageId", { messageId: "msg", attachmentId: "att" }],
    ["get_attachment", "attachmentId", { messageId: "msg", attachmentId: "att" }],
  ];
  it.each(pathParams)("rejects path and query injection in %s.%s at the schema and at request building", async (actionId, name, base) => {
    const action = actions[actionId]!;
    const api = action.directApi!;
    for (const value of injections) {
      const params = { ...base, [name]: value };
      expect(action.paramsSchema!.safeParse(params).success, JSON.stringify(value)).toBe(false);
      const build = () => { if (typeof api.url === "function") api.url(params); api.mapParams?.(params); };
      expect(build, JSON.stringify(value)).toThrow();
      await expect(run(actionId, params)).rejects.toThrow("Invalid action parameters");
    }
  });

  it.each([
    ["get_folder", {}],
    ["list_folder_messages", { folderId: "inbox", top: 0 }],
    ["list_folder_messages", { folderId: "inbox", top: 51 }],
    ["list_folder_messages", { folderId: "inbox", top: 2.5 }],
    ["list_folder_messages", { folderId: "inbox", skip: -1 }],
    ["list_folder_messages", { folderId: "inbox", skip: 5001 }],
    ["list_folder_messages", { folderId: "inbox", top: "25" }],
    ["list_folder_messages", { folderId: "inbox", filter: "isRead eq false" }],
    ["list_folder_messages", { folderId: "inbox", filter: "unread", query: "x" }],
    ["search_messages", {}],
    ["search_messages", { query: "" }],
    ["search_messages", { query: "x".repeat(513) }],
    ["search_messages", { query: "line\nbreak" }],
    ["search_messages", { query: "tab\there" }],
    ["search_messages", { query: "x", top: 51 }],
    ["search_messages", { query: "x", skipToken: "has space" }],
    ["search_messages", { query: "x", skipToken: "" }],
    ["search_messages", { query: "x", skipToken: "t".repeat(2049) }],
    ["search_messages", { query: "x", skip: 10 }],
    ["search_messages", { query: "x", orderby: "subject" }],
    ["list_conversation", { conversationId: "c", skip: 501 }],
    ["list_conversation", { conversationId: "c", top: 51 }],
    ["list_conversation", { conversationId: "c", includeBody: "false" }],
    ["list_conversation", { conversationId: "c' or 1 eq 1" }],
    ["get_message", { messageId: "m", select: "body" }],
    ["list_attachments", {}],
    ["get_attachment", { messageId: "m" }],
  ] satisfies [string, Record<string, unknown>][])("rejects invalid %s parameters %j", async (actionId, params) => {
    expect(actions[actionId]!.paramsSchema!.safeParse(params).success).toBe(false);
    await expect(run(actionId, params)).rejects.toThrow("Invalid action parameters");
  });

  it("raises the reply cap for actions that return HTML bodies or attachment content", () => {
    for (const action of ["get_message", "list_conversation", "get_attachment"]) {
      expect(MICROSOFT_MAIL_REPLY_BYTES[action], action).toBe(1_572_864);
    }
    for (const action of ["get_folder", "list_folder_messages", "search_messages", "list_attachments"]) {
      expect(MICROSOFT_MAIL_REPLY_BYTES[action], action).toBeUndefined();
    }
  });
});
