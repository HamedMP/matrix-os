import { describe, expect, it, vi } from "vitest";
import { MICROSOFT_MAIL_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/microsoft-mail-writes.js";
import { MICROSOFT_MAIL_REPLY_BYTES } from "../../packages/gateway/src/integrations/microsoft-mail-shared.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const me = "https://graph.microsoft.com/v1.0/me";
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };
const ECHO = "?$select=id,conversationId,parentFolderId,isRead,isDraft,flag";
const actions = MICROSOFT_MAIL_WRITE_ACTIONS.microsoft_outlook!;
const ada = { address: "ada@example.com", name: "Ada Lovelace" };
const bob = { address: "bob@example.com" };

async function run(actionId: string, params: Record<string, unknown>) {
  const proxyPost = vi.fn(async () => ({ id: "m1" }));
  const proxyPatch = vi.fn(async () => ({ id: "m1" }));
  const def = { id: "microsoft_outlook", actions } as unknown as ServiceDefinition;
  const result = await executeIntegrationAction({ pipedream: { proxyPost, proxyPatch } as unknown as PipedreamConnectClient,
    externalUserId: "owner", connection: { pipedream_account_id: "account" }, def, actionDef: actions[actionId]!,
    serviceId: "microsoft_outlook", actionId, params });
  return { proxyPost, proxyPatch, result };
}

type WriteCase = [string, Record<string, unknown>, "POST" | "PATCH", string, Record<string, unknown>];
const cases: WriteCase[] = [
  ["update_message", { messageId: "AAMk+1=", isRead: true }, "PATCH", `${me}/messages/AAMk%2B1%3D${ECHO}`, { isRead: true }],
  ["update_message", { messageId: "m1", flagged: true }, "PATCH", `${me}/messages/m1${ECHO}`, { flag: { flagStatus: "flagged" } }],
  ["update_message", { messageId: "m1", isRead: false, flagged: false }, "PATCH", `${me}/messages/m1${ECHO}`,
    { isRead: false, flag: { flagStatus: "notFlagged" } }],
  ["move_message", { messageId: "m1", destinationFolderId: "deleteditems" }, "POST", `${me}/messages/m1/move${ECHO}`,
    { destinationId: "deleteditems" }],
  ["move_message", { messageId: "m1", destinationFolderId: "AAMkFolder=" }, "POST", `${me}/messages/m1/move${ECHO}`,
    { destinationId: "AAMkFolder=" }],
  ["create_html_draft", { subject: "Review", bodyHtml: "<p>Hi</p>" }, "POST", `${me}/messages${ECHO}`,
    { subject: "Review", body: { contentType: "HTML", content: "<p>Hi</p>" } }],
  ["create_html_draft", { toRecipients: [ada], ccRecipients: [bob], bccRecipients: [], subject: "", bodyHtml: "" }, "POST",
    `${me}/messages${ECHO}`, { subject: "", body: { contentType: "HTML", content: "" },
      toRecipients: [{ emailAddress: { address: "ada@example.com", name: "Ada Lovelace" } }],
      ccRecipients: [{ emailAddress: { address: "bob@example.com" } }], bccRecipients: [] }],
  ["create_reply_draft", { messageId: "m1", replyAll: false, bodyHtml: "<p>Thanks</p>" }, "POST",
    `${me}/messages/m1/createReply${ECHO}`, { message: { body: { contentType: "HTML", content: "<p>Thanks</p>" } } }],
  ["create_reply_draft", { messageId: "m1", replyAll: true, bodyHtml: "<p>All</p>" }, "POST",
    `${me}/messages/m1/createReplyAll${ECHO}`, { message: { body: { contentType: "HTML", content: "<p>All</p>" } } }],
  ["update_draft", { messageId: "d1", subject: "New" }, "PATCH", `${me}/messages/d1${ECHO}`, { subject: "New" }],
  ["update_draft", { messageId: "d1", bodyHtml: "<b>x</b>", toRecipients: [bob], ccRecipients: [], bccRecipients: [ada] }, "PATCH",
    `${me}/messages/d1${ECHO}`, { body: { contentType: "HTML", content: "<b>x</b>" },
      toRecipients: [{ emailAddress: { address: "bob@example.com" } }], ccRecipients: [],
      bccRecipients: [{ emailAddress: { address: "ada@example.com", name: "Ada Lovelace" } }] }],
  ["delete_draft", { messageId: "d1" }, "POST", `${me}/messages/d1/move${ECHO}`, { destinationId: "deleteditems" }],
  ["send_draft", { messageId: "d1" }, "POST", `${me}/messages/d1/send`, {}],
  ["add_attachment", { messageId: "d1", name: "notes.txt", contentType: "text/plain", contentBase64: "aGVsbG8=" }, "POST",
    `${me}/messages/d1/attachments`, { "@odata.type": "#microsoft.graph.fileAttachment", name: "notes.txt",
      contentType: "text/plain", contentBytes: "aGVsbG8=" }],
];

describe("microsoft_outlook mail writes", () => {
  it("publishes exactly the specified write actions, all write risk with strict schemas", () => {
    expect(Object.keys(MICROSOFT_MAIL_WRITE_ACTIONS)).toEqual(["microsoft_outlook"]);
    expect(Object.keys(actions).sort()).toEqual(["add_attachment", "create_html_draft", "create_reply_draft", "delete_draft",
      "move_message", "send_draft", "update_draft", "update_message"]);
    for (const [id, action] of Object.entries(actions)) {
      expect(action.risk, id).toBe("write");
      expect(action.paramsSchema, id).toBeDefined();
      expect(action.description, id).toMatch(/approv/i);
      const shape = (action.paramsSchema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(action.params).sort(), id).toEqual(Object.keys(shape).sort());
    }
  });

  it.each(cases)("maps %s to the exact Graph request", async (actionId, params, method, url, body) => {
    const action = actions[actionId]!;
    expect(action.directApi?.method).toBe(method);
    expect(action.paramsSchema!.safeParse(params).success).toBe(true);
    expect(action.paramsSchema!.safeParse({ ...params, arbitraryUrl: "https://evil.example" }).success).toBe(false);
    const { proxyPost, proxyPatch, result } = await run(actionId, params);
    expect(result.data).toEqual({ id: "m1" });
    const used = method === "PATCH" ? proxyPatch : proxyPost;
    expect(proxyPost.mock.calls.length + proxyPatch.mock.calls.length).toBe(1);
    expect(used.mock.calls[0]).toEqual([{ externalUserId: "owner", accountId: "account", url, body, headers: IMMUTABLE }]);
  });

  it("send_draft accepts only a draft id, so no arbitrary content can be sent", async () => {
    const schema = actions.send_draft!.paramsSchema!;
    for (const extra of [{ bodyHtml: "<p>x</p>" }, { toRecipients: [ada] }, { subject: "x" }, { message: {} }]) {
      expect(schema.safeParse({ messageId: "d1", ...extra }).success).toBe(false);
    }
    expect(Object.keys(actions.send_draft!.params)).toEqual(["messageId"]);
  });

  const injections = ["", "../x", "m1/../m2", "?q", "m1?$expand=x", "m1#f", "\n", "m1\n", "a b", "m'1", "a".repeat(513)];
  const pathParams: [string, string, Record<string, unknown>][] = [
    ["update_message", "messageId", { messageId: "m1", isRead: true }],
    ["move_message", "messageId", { messageId: "m1", destinationFolderId: "inbox" }],
    ["create_reply_draft", "messageId", { messageId: "m1", replyAll: false, bodyHtml: "x" }],
    ["update_draft", "messageId", { messageId: "m1", subject: "x" }],
    ["delete_draft", "messageId", { messageId: "m1" }],
    ["send_draft", "messageId", { messageId: "m1" }],
    ["add_attachment", "messageId", { messageId: "m1", name: "a.txt", contentType: "text/plain", contentBase64: "" }],
  ];
  it.each(pathParams)("rejects path and query injection in %s.%s at the schema and at request building", async (actionId, name, base) => {
    const action = actions[actionId]!;
    for (const value of injections) {
      const params = { ...base, [name]: value };
      expect(action.paramsSchema!.safeParse(params).success, JSON.stringify(value)).toBe(false);
      expect(() => (action.directApi!.url as (p: Record<string, unknown>) => string)(params), JSON.stringify(value)).toThrow();
      await expect(run(actionId, params)).rejects.toThrow("Invalid action parameters");
    }
  });

  const many = (count: number) => Array.from({ length: count }, (_, i) => ({ address: `p${i}@example.com` }));
  it.each([
    ["update_message", { messageId: "m1" }],
    ["update_message", { messageId: "m1", isRead: "true" }],
    ["update_message", { messageId: "m1", flag: { flagStatus: "flagged" } }],
    ["move_message", { messageId: "m1" }],
    ["move_message", { messageId: "m1", destinationFolderId: "../inbox" }],
    ["move_message", { messageId: "m1", destinationFolderId: "inbox\n" }],
    ["create_html_draft", { bodyHtml: "x" }],
    ["create_html_draft", { subject: "x" }],
    ["create_html_draft", { subject: "line\nbreak", bodyHtml: "x" }],
    ["create_html_draft", { subject: "x".repeat(256), bodyHtml: "x" }],
    ["create_html_draft", { subject: "x", bodyHtml: "x".repeat(60001) }],
    ["create_html_draft", { subject: "x", bodyHtml: "x".repeat(59950), toRecipients: [ada, bob] }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: [{ address: "not-an-address" }] }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: [{ address: "ada@example.com", name: "" }] }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: [{ address: "ada@example.com", name: "A\r\nBcc: e@x.com" }] }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: [{ address: "ada@example.com", name: "n".repeat(129) }] }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: [{ address: "ada@example.com", extra: true }] }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: [{ emailAddress: { address: "ada@example.com" } }] }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: many(60), ccRecipients: many(41) }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", toRecipients: many(101) }],
    ["create_html_draft", { subject: "x", bodyHtml: "x", attachments: [] }],
    ["create_reply_draft", { messageId: "m1", bodyHtml: "x" }],
    ["create_reply_draft", { messageId: "m1", replyAll: "false", bodyHtml: "x" }],
    ["create_reply_draft", { messageId: "m1", replyAll: false }],
    ["create_reply_draft", { messageId: "m1", replyAll: false, bodyHtml: "x".repeat(60001) }],
    ["create_reply_draft", { messageId: "m1", replyAll: false, bodyHtml: "x", toRecipients: [ada] }],
    ["update_draft", { messageId: "d1" }],
    ["update_draft", { messageId: "d1", subject: "a\u0007b" }],
    ["update_draft", { messageId: "d1", bodyHtml: "x".repeat(59990), subject: "y".repeat(20) }],
    ["update_draft", { messageId: "d1", toRecipients: many(50), ccRecipients: many(50), bccRecipients: many(1) }],
    ["delete_draft", { messageId: "d1", destinationFolderId: "inbox" }],
    ["send_draft", {}],
    ["add_attachment", { messageId: "d1", name: "a.txt", contentType: "text/plain" }],
    ["add_attachment", { messageId: "d1", name: "../a.txt", contentType: "text/plain", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "a\\b.txt", contentType: "text/plain", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "a\".txt", contentType: "text/plain", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "a\n.txt", contentType: "text/plain", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "", contentType: "text/plain", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "n".repeat(256), contentType: "text/plain", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "a.txt", contentType: "text", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "a.txt", contentType: "text/plain; charset=x", contentBase64: "" }],
    ["add_attachment", { messageId: "d1", name: "a.txt", contentType: "text/plain", contentBase64: "aGVsbG8" }],
    ["add_attachment", { messageId: "d1", name: "a.txt", contentType: "text/plain", contentBase64: "aGVs bG8=" }],
    ["add_attachment", { messageId: "d1", name: "a.txt", contentType: "text/plain", contentBase64: "aGVs_G8=" }],
    ["add_attachment", { messageId: "d1", name: "a.txt", contentType: "text/plain", contentBase64: "QUFB".repeat(15001) }],
  ] satisfies [string, Record<string, unknown>][])("rejects invalid %s parameters (case %#)", async (actionId, params) => {
    expect(actions[actionId]!.paramsSchema!.safeParse(params).success).toBe(false);
    await expect(run(actionId, params)).rejects.toThrow("Invalid action parameters");
  });

  it("accepts a draft that fits exactly within the shared request budget and 100 recipients", () => {
    const schema = actions.create_html_draft!.paramsSchema!;
    expect(schema.safeParse({ subject: "x", bodyHtml: "x", toRecipients: many(50), ccRecipients: many(30), bccRecipients: many(20) }).success).toBe(true);
    const base = { subject: "", bodyHtml: "" };
    const room = 60_000 - Buffer.byteLength(JSON.stringify(base));
    expect(schema.safeParse({ subject: "", bodyHtml: "x".repeat(room) }).success).toBe(true);
    expect(schema.safeParse({ subject: "", bodyHtml: "x".repeat(room + 1) }).success).toBe(false);
    // Multibyte bodies are measured in bytes, not characters.
    expect(schema.safeParse({ subject: "", bodyHtml: "é".repeat(30_000) }).success).toBe(false);
    expect(actions.add_attachment!.paramsSchema!.safeParse({ messageId: "d1", name: "a.bin", contentType: "application/octet-stream",
      contentBase64: "QUFB".repeat(14_000) }).success).toBe(true);
  });

  it("raises the write reply cap for writes that echo a message", () => {
    for (const action of ["update_message", "move_message", "create_html_draft", "create_reply_draft", "update_draft"]) {
      expect(MICROSOFT_MAIL_REPLY_BYTES[action], action).toBe(1_572_864);
    }
    for (const action of ["send_draft", "add_attachment"]) expect(MICROSOFT_MAIL_REPLY_BYTES[action], action).toBeUndefined();
  });
});
