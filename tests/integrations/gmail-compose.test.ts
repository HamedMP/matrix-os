import { describe, expect, it, vi } from "vitest";
import { GMAIL_COMPOSE_READ_ACTIONS, GMAIL_COMPOSE_REPLY_BYTES, GMAIL_COMPOSE_WRITE_ACTIONS } from "../../packages/gateway/src/integrations/gmail-compose.js";
import { buildMimeMessage, type MimeMessageInput } from "../../packages/gateway/src/integrations/gmail-mime.js";
import { executeIntegrationAction } from "../../packages/gateway/src/integrations/action-execution.js";
import { validateActionParams } from "../../packages/gateway/src/integrations/parameter-validation.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction, ServiceDefinition } from "../../packages/gateway/src/integrations/types.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const writes = GMAIL_COMPOSE_WRITE_ACTIONS.gmail!;
const actions: Record<string, ServiceAction> = { ...GMAIL_COMPOSE_READ_ACTIONS, ...writes };
const FULL_MASK = "id,historyId,messages(id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload)";
const SUMMARY_MASK = "id,historyId,messages(id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(mimeType,filename,headers,body(size,attachmentId),parts(mimeType,filename,body(size,attachmentId),parts(mimeType,filename,body(size,attachmentId)))))";

function fakeClient() {
  // Separate mocks per method: vi.fn(sharedMock) would share one call record.
  const reply = () => vi.fn(async (_request: Record<string, unknown>) => ({ id: "reply" }));
  const client = { proxyGet: reply(), proxyPost: reply(), proxyPut: reply(), proxyDelete: reply(), proxyPatch: reply() };
  const calls = () => Object.values(client).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
  return { client, calls, pipedream: client as unknown as PipedreamConnectClient };
}
function run(actionId: string, params: Record<string, unknown>, pipedream: PipedreamConnectClient) {
  return executeIntegrationAction({ pipedream, externalUserId: "owner", connection: { pipedream_account_id: "account" },
    def: { id: "gmail", actions } as unknown as ServiceDefinition, actionDef: actions[actionId]!, serviceId: "gmail", actionId, params });
}
const identity = { externalUserId: "owner", accountId: "account" };

describe("gmail compose and triage action maps", () => {
  it("exports exactly the reviewed reads and writes with strict schemas and matching parameter metadata", () => {
    expect(Object.keys(GMAIL_COMPOSE_WRITE_ACTIONS)).toEqual(["gmail"]);
    expect(Object.keys(writes).sort()).toEqual(["batch_modify", "create_html_draft", "create_reply_draft", "delete_draft", "send_draft", "update_draft"]);
    expect(Object.keys(GMAIL_COMPOSE_READ_ACTIONS).sort()).toEqual(["get_label", "get_thread", "list_drafts", "list_threads_query"]);
    expect(GMAIL_COMPOSE_REPLY_BYTES).toEqual({ "gmail/get_thread": 1_572_864 });
    for (const [id, action] of Object.entries(actions)) {
      expect(action.risk, id).toBe(id in writes ? "write" : "read");
      expect(action.componentKey).toBeUndefined();
      expect(action.directApi).toBeDefined();
      const shape = (action.paramsSchema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape).sort(), id).toEqual(Object.keys(action.params).sort());
      expect(action.paramsSchema!.safeParse({ arbitraryUrl: "https://evil.example" }).success).toBe(false);
    }
  });

  it.each([
    ["send_draft", { draftId: "r-123_A" }, "proxyPost", { url: `${BASE}/drafts/send`, body: { id: "r-123_A" } }],
    ["delete_draft", { draftId: "r-123_A" }, "proxyDelete", { url: `${BASE}/drafts/r-123_A`, params: undefined }],
    ["batch_modify", { messageIds: ["m1", "m2"], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] }, "proxyPost",
      { url: `${BASE}/messages/batchModify`, body: { ids: ["m1", "m2"], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] } }],
    ["batch_modify", { messageIds: ["m1"], removeLabelIds: ["UNREAD"] }, "proxyPost",
      { url: `${BASE}/messages/batchModify`, body: { ids: ["m1"], removeLabelIds: ["UNREAD"] } }],
    ["get_thread", { threadId: "t1" }, "proxyGet", { url: `${BASE}/threads/t1?format=full&fields=${FULL_MASK}`, params: undefined }],
    ["get_thread", { threadId: "t1", format: "full" }, "proxyGet", { url: `${BASE}/threads/t1?format=full&fields=${FULL_MASK}`, params: undefined }],
    ["get_thread", { threadId: "t1", format: "summary" }, "proxyGet", { url: `${BASE}/threads/t1?format=full&fields=${SUMMARY_MASK}`, params: undefined }],
    ["get_label", { labelId: "Label_12" }, "proxyGet", { url: `${BASE}/labels/Label_12`, params: undefined }],
    ["list_drafts", {}, "proxyGet", { url: `${BASE}/drafts`, params: { maxResults: "25" } }],
    ["list_drafts", { query: "to:ada@example.com", maxResults: 100, pageToken: "tok/+=" }, "proxyGet",
      { url: `${BASE}/drafts`, params: { q: "to:ada@example.com", maxResults: "100", pageToken: "tok/+=" } }],
    ["list_threads_query", {}, "proxyGet", { url: `${BASE}/threads?maxResults=25`, params: undefined }],
    ["list_threads_query", { query: "from:ada subject:\"Q3 & Q4\"", labelIds: ["INBOX", "Label_1"], maxResults: 10, pageToken: "abc+/=" }, "proxyGet",
      { url: `${BASE}/threads?labelIds=INBOX&labelIds=Label_1&q=from%3Aada%20subject%3A%22Q3%20%26%20Q4%22&maxResults=10&pageToken=abc%2B%2F%3D`, params: undefined }],
    ["list_threads_query", { labelIds: ["TRASH"] }, "proxyGet", { url: `${BASE}/threads?labelIds=TRASH&maxResults=25&includeSpamTrash=true`, params: undefined }],
    ["list_threads_query", { labelIds: ["SPAM", "UNREAD"], query: "" }, "proxyGet",
      { url: `${BASE}/threads?labelIds=SPAM&labelIds=UNREAD&maxResults=25&includeSpamTrash=true`, params: undefined }],
  ] as [string, Record<string, unknown>, keyof ReturnType<typeof fakeClient>["client"], Record<string, unknown>][])(
    "maps %s %j to the exact provider request", async (actionId, params, method, expected) => {
      const { client, calls, pipedream } = fakeClient();
      const result = await run(actionId, params, pipedream);
      expect(result).toEqual({ data: { id: "reply" } });
      expect(client[method]).toHaveBeenCalledTimes(1);
      expect(client[method]).toHaveBeenCalledWith({ ...identity, ...expected });
      expect(calls()).toBe(1);
      expect(validateActionParams(actions[actionId]!, params)).toEqual({ valid: true });
    });
});

const draft = {
  to: [{ address: "ada@example.com", name: "Ada Lovelace" }, { address: "zoe@example.com", name: "Zoë" }],
  cc: [{ address: "bob@example.com" }], bcc: [{ address: "eve@example.com" }],
  subject: "Re: Plan för Q3", bodyHtml: "<p>Looks good.</p>", bodyText: "Looks good.",
  attachments: [{ filename: "notes.txt", mimeType: "text/plain", contentBase64: Buffer.from("notes").toString("base64") }],
};
const reply = { ...draft, threadId: "thread_9", inReplyTo: "<b@mail.example.com>", references: ["<a@mail.example.com>", "<b@mail.example.com>"] };
// Stand-in boundaries keep the random boundary's length, so header folding matches.
const fixedBoundary = (n: number) => `=_mx_${String(n).padStart(32, "0")}`;
const normalise = (message: string) => {
  const seen = new Map<string, string>();
  return message.replace(/=_mx_[0-9a-f]{32}/g, (boundary) => {
    if (!seen.has(boundary)) seen.set(boundary, fixedBoundary(seen.size + 1));
    return seen.get(boundary)!;
  });
};
const expectedMime = (input: MimeMessageInput) => { let n = 0; return buildMimeMessage(input, { boundary: () => fixedBoundary(++n) }); };

describe("gmail draft writes build MIME from validated parameters", () => {
  it.each([
    ["create_html_draft", draft, "proxyPost", `${BASE}/drafts`, undefined, { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, bodyHtml: draft.bodyHtml, bodyText: draft.bodyText, attachments: draft.attachments }],
    ["create_html_draft", { subject: "", bodyHtml: "", bodyText: "" }, "proxyPost", `${BASE}/drafts`, undefined, { subject: "", bodyHtml: "", bodyText: "" }],
    ["create_reply_draft", reply, "proxyPost", `${BASE}/drafts`, "thread_9", { ...draft, inReplyTo: reply.inReplyTo, references: reply.references }],
    ["update_draft", { ...reply, draftId: "r-55" }, "proxyPut", `${BASE}/drafts/r-55`, "thread_9", { ...draft, inReplyTo: reply.inReplyTo, references: reply.references }],
    ["update_draft", { draftId: "r-55", subject: "New", bodyHtml: "<b>x</b>", bodyText: "x" }, "proxyPut", `${BASE}/drafts/r-55`, undefined, { subject: "New", bodyHtml: "<b>x</b>", bodyText: "x" }],
  ] as [string, Record<string, unknown>, "proxyPost" | "proxyPut", string, string | undefined, MimeMessageInput][])(
    "%s sends the exact draft resource", async (actionId, params, method, url, threadId, mime) => {
      const { client, calls, pipedream } = fakeClient();
      await run(actionId, params, pipedream);
      expect(calls()).toBe(1);
      expect(client[method]).toHaveBeenCalledWith({ ...identity, url,
        body: { message: { raw: expect.stringMatching(/^[A-Za-z0-9_-]+$/), ...(threadId ? { threadId } : {}) } } });
      const call = client[method].mock.calls[0]![0] as { body: { message: { raw: string } } };
      const decoded = Buffer.from(call.body.message.raw, "base64url").toString("utf8");
      expect(normalise(decoded)).toBe(expectedMime(mime));
      expect(decoded).not.toMatch(/^(From|Date):/m);
      expect(validateActionParams(actions[actionId]!, params)).toEqual({ valid: true });
    });

  it("keeps the attachment, Bcc and threading headers in the stored reply draft", async () => {
    const { client, pipedream } = fakeClient();
    await run("create_reply_draft", reply, pipedream);
    const call = client.proxyPost.mock.calls[0]![0] as { body: { message: { raw: string } } };
    const decoded = Buffer.from(call.body.message.raw, "base64url").toString("utf8");
    expect(decoded).toContain("\r\nBcc: eve@example.com\r\n");
    expect(decoded).toContain("\r\nIn-Reply-To: <b@mail.example.com>\r\n");
    expect(decoded).toContain("\r\nReferences: <a@mail.example.com> <b@mail.example.com>\r\n");
    expect(decoded).toContain("Content-Disposition: attachment; filename=\"notes.txt\"");
  });
});

const injection = ["", "../x", "?q", "\n", "x\n", "a/b", "a%2Fb", "a#b", "a b", "x".repeat(129)];
const idParams: [string, string, Record<string, unknown>][] = [
  ["update_draft", "draftId", { draftId: "d", subject: "", bodyHtml: "", bodyText: "" }],
  ["delete_draft", "draftId", { draftId: "d" }],
  ["get_thread", "threadId", { threadId: "t" }],
  ["get_label", "labelId", { labelId: "l" }],
];

describe("gmail compose and triage parameter validation", () => {
  it.each(idParams)("rejects path injection in %s.%s at the schema and URL boundaries", async (actionId, name, valid) => {
    const action = actions[actionId]!;
    const url = action.directApi!.url as (params: Record<string, unknown>) => string;
    expect(action.paramsSchema!.safeParse(valid).success).toBe(true);
    for (const value of injection) {
      const params = { ...valid, [name]: value };
      expect(action.paramsSchema!.safeParse(params).success, JSON.stringify(value)).toBe(false);
      expect(() => url(params)).toThrow();
      const { calls, pipedream } = fakeClient();
      await expect(run(actionId, params, pipedream)).rejects.toThrow("Invalid action parameters");
      expect(calls()).toBe(0);
    }
  });

  it("rejects unsafe ids in bodies and query strings too", () => {
    for (const value of injection) {
      expect(writes.send_draft!.paramsSchema!.safeParse({ draftId: value }).success).toBe(false);
      expect(writes.create_reply_draft!.paramsSchema!.safeParse({ ...reply, threadId: value }).success).toBe(false);
      expect(writes.batch_modify!.paramsSchema!.safeParse({ messageIds: [value], addLabelIds: ["STARRED"] }).success).toBe(false);
      expect(writes.batch_modify!.paramsSchema!.safeParse({ messageIds: ["m"], addLabelIds: [value] }).success).toBe(false);
      const listUrl = GMAIL_COMPOSE_READ_ACTIONS.list_threads_query!.directApi!.url as (params: Record<string, unknown>) => string;
      expect(GMAIL_COMPOSE_READ_ACTIONS.list_threads_query!.paramsSchema!.safeParse({ labelIds: [value] }).success).toBe(false);
      expect(() => listUrl({ labelIds: [value] })).toThrow();
    }
  });

  const recipients = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `p${i}@example.com` }));
  const file = { filename: "a.txt", mimeType: "text/plain", contentBase64: "YQ==" };
  it.each([
    ["create_html_draft", { bodyHtml: "", bodyText: "" }],
    ["create_html_draft", { ...draft, subject: "Hi\r\nBcc: attacker@evil.example" }],
    ["create_html_draft", { ...draft, subject: "x".repeat(256) }],
    ["create_html_draft", { ...draft, to: [{ address: "not-an-address" }] }],
    ["create_html_draft", { ...draft, to: [{ address: "a@example.com\r\nBcc: e@evil.example" }] }],
    ["create_html_draft", { ...draft, to: [{ address: "a@example.com", name: "A\nBcc: e@evil.example" }] }],
    ["create_html_draft", { ...draft, to: [{ address: "a@example.com", name: "" }] }],
    ["create_html_draft", { ...draft, to: [{ address: "a@example.com", name: "x".repeat(129) }] }],
    ["create_html_draft", { ...draft, to: [{ address: "a@example.com", extra: true }] }],
    ["create_html_draft", { ...draft, to: recipients(101), cc: [], bcc: [] }],
    ["create_html_draft", { ...draft, to: recipients(50), cc: recipients(50), bcc: recipients(1) }],
    ["create_html_draft", { ...draft, bodyHtml: "x".repeat(60001) }],
    ["create_html_draft", { ...draft, bodyHtml: "x".repeat(30000), bodyText: "y".repeat(30000) }],
    ["create_html_draft", { ...draft, attachments: Array.from({ length: 11 }, () => file) }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, filename: "../etc/passwd" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, filename: "a\\b" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, filename: "a\".txt" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, filename: "a\r\nX: y" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, filename: "" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, mimeType: "text/plain\r\nX: y" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, mimeType: "text" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, contentBase64: "YQ" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, contentBase64: "YQ==\r\n" }] }],
    ["create_html_draft", { ...draft, attachments: [{ ...file, contentBase64: "Y-_=" }] }],
    ["create_html_draft", { ...draft, threadId: "t" }],
    ["create_reply_draft", { ...draft, inReplyTo: "<a@b>" }],
    ["create_reply_draft", { ...draft, threadId: "t" }],
    ["create_reply_draft", { ...reply, inReplyTo: "a@b" }],
    ["create_reply_draft", { ...reply, inReplyTo: "<a@b>\r\nBcc: e@evil.example" }],
    ["create_reply_draft", { ...reply, inReplyTo: "<a b@c>" }],
    ["create_reply_draft", { ...reply, inReplyTo: `<${"x".repeat(996)}>` }],
    ["create_reply_draft", { ...reply, references: Array.from({ length: 21 }, (_, i) => `<${i}@e>`) }],
    ["create_reply_draft", { ...reply, references: ["<ok@e>", "bad"] }],
    ["update_draft", { ...draft }],
    ["update_draft", { draftId: "d", bodyHtml: "", bodyText: "" }],
    ["update_draft", { draftId: "d", subject: "", bodyHtml: "", bodyText: "", inReplyTo: "<a@b>\n" }],
    ["send_draft", {}],
    ["send_draft", { draftId: "d", raw: "U3ViamVjdDogaGk" }],
    ["delete_draft", { draftId: "d", messageId: "m" }],
    ["batch_modify", { messageIds: ["m"] }],
    ["batch_modify", { messageIds: ["m"], addLabelIds: [], removeLabelIds: [] }],
    ["batch_modify", { messageIds: [], addLabelIds: ["STARRED"] }],
    ["batch_modify", { messageIds: Array.from({ length: 101 }, (_, i) => `m${i}`), addLabelIds: ["STARRED"] }],
    ["batch_modify", { messageIds: ["m", "m"], addLabelIds: ["STARRED"] }],
    ["batch_modify", { messageIds: ["m"], addLabelIds: ["STARRED", "STARRED"] }],
    ["batch_modify", { messageIds: ["m"], addLabelIds: ["STARRED"], removeLabelIds: ["STARRED"] }],
    ["batch_modify", { messageIds: ["m"], addLabelIds: ["DRAFT"] }],
    ["batch_modify", { messageIds: ["m"], removeLabelIds: ["DRAFT"] }],
    ["batch_modify", { messageIds: ["m"], addLabelIds: ["SENT"] }],
    ["batch_modify", { messageIds: ["m"], removeLabelIds: ["SENT"] }],
    ["batch_modify", { messageIds: ["m"], addLabelIds: Array.from({ length: 21 }, (_, i) => `L${i}`) }],
    ["batch_modify", { messageIds: "m", addLabelIds: ["STARRED"] }],
    ["get_thread", { threadId: "t", format: "raw" }],
    ["get_thread", { threadId: "t", format: "metadata" }],
    ["get_label", {}],
    ["list_drafts", { maxResults: 0 }],
    ["list_drafts", { maxResults: 101 }],
    ["list_drafts", { maxResults: 1.5 }],
    ["list_drafts", { pageToken: "a b" }],
    ["list_drafts", { pageToken: "x".repeat(2049) }],
    ["list_drafts", { query: "x".repeat(4097) }],
    ["list_drafts", { query: "\ud800" }],
    ["list_threads_query", { maxResults: 0 }],
    ["list_threads_query", { maxResults: 101 }],
    ["list_threads_query", { labelIds: ["A", "A"] }],
    ["list_threads_query", { labelIds: Array.from({ length: 11 }, (_, i) => `L${i}`) }],
    ["list_threads_query", { query: "x".repeat(4097) }],
    ["list_threads_query", { query: "\udc00 lone" }],
    ["list_threads_query", { pageToken: "a\nb" }],
    ["list_threads_query", { includeSpamTrash: true }],
  ] as [string, Record<string, unknown>][])("rejects invalid %s parameters %#", async (actionId, params) => {
    const action = actions[actionId]!;
    expect(action.paramsSchema!.safeParse(params).success).toBe(false);
    const { calls, pipedream } = fakeClient();
    await expect(run(actionId, params, pipedream)).rejects.toThrow("Invalid action parameters");
    expect(calls()).toBe(0);
  });

  it("accepts boundary values", () => {
    const ok = (actionId: string, params: Record<string, unknown>) => expect(actions[actionId]!.paramsSchema!.safeParse(params).success, actionId).toBe(true);
    ok("create_html_draft", { ...draft, to: recipients(98), cc: recipients(1), bcc: recipients(1) });
    ok("create_html_draft", { ...draft, attachments: Array.from({ length: 10 }, () => file) });
    ok("create_html_draft", { subject: "x".repeat(255), bodyHtml: "x".repeat(59000), bodyText: "" });
    ok("create_reply_draft", { ...reply, references: Array.from({ length: 20 }, (_, i) => `<${i}@e>`) });
    ok("create_reply_draft", { ...reply, inReplyTo: `<${"x".repeat(995)}>` });
    ok("batch_modify", { messageIds: Array.from({ length: 100 }, (_, i) => `m${i}`), addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
    ok("list_threads_query", { labelIds: Array.from({ length: 10 }, (_, i) => `L${i}`), maxResults: 100, query: "x".repeat(4096) });
    ok("list_drafts", { maxResults: 1, pageToken: "x".repeat(2048) });
  });
});
