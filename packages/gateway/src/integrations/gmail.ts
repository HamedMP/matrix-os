import { z } from "zod/v4";
import type { ServiceDefinition } from "./types.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const pageToken = z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/).optional();
const maxResults = z.number().int().min(1).max(500).optional();
const query = z.string().max(4096);
const pagination = { maxResults, pageToken };
// TRASH is deliberately unsupported, including through generic label mutation.
const mutableLabelId = identifier.refine((id) => id !== "TRASH");
const labelIds = z.array(mutableLabelId).max(100)
  .refine((ids) => new Set(ids).size === ids.length).optional();
const modifySchema = z.strictObject({
  messageId: identifier, addLabelIds: labelIds, removeLabelIds: labelIds,
}).refine((p) => (p.addLabelIds?.length ?? 0) + (p.removeLabelIds?.length ?? 0) > 0)
  .refine((p) => !p.addLabelIds?.some((id) => p.removeLabelIds?.includes(id)));

function mapPagination(p: Record<string, unknown>): Record<string, string> {
  return {
    ...(p.maxResults !== undefined ? { maxResults: String(p.maxResults) } : {}),
    ...(p.pageToken !== undefined ? { pageToken: String(p.pageToken) } : {}),
  };
}

// Strip CR/LF only from headers. Body newlines are legitimate message content.
const stripCrLf = (s: unknown): string => String(s).replace(/[\r\n]/g, "");
const toBase64Url = (msg: string): string => Buffer.from(msg, "utf-8").toString("base64url");

export const GMAIL_SERVICE: ServiceDefinition = {
  connectorKind: "pipedream",
  id: "gmail", name: "Gmail", category: "google", pipedreamApp: "gmail", icon: "mail",
  logoUrl: "https://pipedream.com/s.v0/gmail/logo/48",
  actions: {
    list_messages: {
      risk: "read",
      description: "List a page of email messages; use nextPageToken to continue",
      params: { query: { type: "string" }, maxResults: { type: "number" }, pageToken: { type: "string" } },
      paramsSchema: z.strictObject({ query: query.optional(), ...pagination }),
      directApi: {
        method: "GET", url: `${BASE}/messages`,
        mapParams: (p) => ({ ...mapPagination(p), ...(p.query ? { q: String(p.query) } : {}) }),
      },
    },
    get_message: {
      risk: "read",
      description: "Get a specific email message by ID",
      params: { messageId: { type: "string", required: true } },
      paramsSchema: z.strictObject({ messageId: identifier }),
      directApi: {
        method: "GET", url: (p) => `${BASE}/messages/${encodeURIComponent(String(p.messageId))}?format=full`,
      },
    },
    // Preserve the existing plain-text RFC 2822 send interface. Multipart
    // attachments and HTML bodies are outside this connector's send action.
    send_email: {
      risk: "write",
      description: "Send an email",
      params: {
        to: { type: "string", required: true }, subject: { type: "string", required: true },
        body: { type: "string", required: true }, cc: { type: "string" },
      },
      paramsSchema: z.strictObject({
        to: z.string().min(1).max(4096), subject: z.string().max(4096),
        body: z.string().max(60000), cc: z.string().max(4096).optional(),
      }),
      directApi: {
        method: "POST", url: `${BASE}/messages/send`,
        mapBody: (p) => {
          const headers = [
            `To: ${stripCrLf(p.to)}`, `Subject: ${stripCrLf(p.subject)}`,
            ...(p.cc ? [`Cc: ${stripCrLf(p.cc)}`] : []),
            'Content-Type: text/plain; charset="UTF-8"', "MIME-Version: 1.0",
          ];
          return { raw: toBase64Url(`${headers.join("\r\n")}\r\n\r\n${String(p.body)}`) };
        },
      },
    },
    search: {
      risk: "read",
      description: "Search a page of emails; use nextPageToken to continue",
      params: { query: { type: "string", required: true }, maxResults: { type: "number" }, pageToken: { type: "string" } },
      paramsSchema: z.strictObject({ query, ...pagination }),
      directApi: {
        method: "GET", url: `${BASE}/messages`,
        mapParams: (p) => ({ q: String(p.query), ...mapPagination(p) }),
      },
    },
    list_labels: {
      risk: "read",
      description: "List all email labels", params: {}, paramsSchema: z.strictObject({}),
      directApi: { method: "GET", url: `${BASE}/labels` },
    },
    list_history: {
      risk: "read",
      description: "Read a page of mailbox changes after a string history ID; expired IDs require a full resync",
      params: { startHistoryId: { type: "string", required: true }, maxResults: { type: "number" }, pageToken: { type: "string" } },
      paramsSchema: z.strictObject({ startHistoryId: z.string().min(1).max(20).regex(/^\d+$/), ...pagination }),
      directApi: {
        method: "GET", url: `${BASE}/history`,
        // Never convert IDs to numbers: Gmail history IDs can exceed 2^53.
        mapParams: (p) => ({ startHistoryId: String(p.startHistoryId), ...mapPagination(p) }),
      },
    },
    create_label: {
      risk: "write",
      description: "Create a Gmail label",
      params: { name: { type: "string", required: true } },
      paramsSchema: z.strictObject({ name: z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/).refine((s) => s.trim().length > 0) }),
      directApi: { method: "POST", url: `${BASE}/labels`, mapBody: (p) => ({ name: p.name }) },
    },
    modify_message: {
      risk: "write",
      description: "Explicitly add/remove labels on one message; remove INBOX to archive or UNREAD to mark read",
      params: { messageId: { type: "string", required: true }, addLabelIds: { type: "array" }, removeLabelIds: { type: "array" } },
      paramsSchema: modifySchema,
      directApi: {
        method: "POST", url: (p) => `${BASE}/messages/${encodeURIComponent(String(p.messageId))}/modify`,
        mapBody: (p) => ({
          ...(p.addLabelIds !== undefined ? { addLabelIds: p.addLabelIds } : {}),
          ...(p.removeLabelIds !== undefined ? { removeLabelIds: p.removeLabelIds } : {}),
        }),
      },
    },
  },
};
