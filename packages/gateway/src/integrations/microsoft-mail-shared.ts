import { z } from "zod/v4";
import { CURSOR, GRAPH_ID, integer, optional, segment, strictFields, type CatalogField } from "./catalog-fields.js";
import type { DirectApi, ServiceAction } from "./types.js";

// Microsoft Graph v1.0 mail contracts:
// https://learn.microsoft.com/graph/api/resources/message
// https://learn.microsoft.com/graph/outlook-immutable-id
// https://learn.microsoft.com/graph/search-query-parameter
export const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";

/** Immutable ids keep a message id stable when it moves between folders. */
export const IMMUTABLE_ID_HEADERS: Readonly<Record<string, string>> = Object.freeze({ Prefer: 'IdType="ImmutableId"' });
/** Bodies are always requested as HTML so the app sanitises one format. */
export const HTML_BODY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"',
});

export const MESSAGE_SUMMARY_SELECT = "id,conversationId,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,"
  + "sentDateTime,receivedDateTime,isRead,isDraft,flag,hasAttachments,parentFolderId";
export const MESSAGE_FULL_SELECT = `${MESSAGE_SUMMARY_SELECT},bccRecipients,replyTo,body`;
/** Writes that echo a whole message are reduced to these fields by the provider. */
export const WRITE_ECHO_QUERY = "?$select=id,conversationId,parentFolderId,isRead,isDraft,flag";

/** Whole-request limit shared by the app bridge, gateway route and body limits (64 KiB minus headroom). */
export const MAX_COMPOSE_REQUEST_BYTES = 60_000;
export const MAX_BODY_HTML_CHARS = 60_000;
export const MAX_DRAFT_RECIPIENTS = 100;

const LARGE_REPLY_BYTES = 1536 * 1024;
/**
 * Per-action reply caps for `appIntegrationReplyBytes("microsoft_outlook", action)`.
 * Reads return HTML bodies or base64 attachment content; the five writes echo a message.
 * Actions not listed keep the default cap.
 */
export const MICROSOFT_MAIL_REPLY_BYTES: Readonly<Record<string, number>> = Object.freeze({
  get_message: LARGE_REPLY_BYTES,
  list_conversation: LARGE_REPLY_BYTES,
  get_attachment: LARGE_REPLY_BYTES,
  update_message: LARGE_REPLY_BYTES,
  move_message: LARGE_REPLY_BYTES,
  create_html_draft: LARGE_REPLY_BYTES,
  create_reply_draft: LARGE_REPLY_BYTES,
  update_draft: LARGE_REPLY_BYTES,
});

const NO_CONTROL = /^[^\x00-\x1f\x7f]*$/;

export const graphId = GRAPH_ID;
export const optionalGraphId = optional(GRAPH_ID);
/** Validate a Graph id, then percent-encode it for one URL path segment. */
export const graphPath = (params: Record<string, unknown>, name: string) => segment(params, name, GRAPH_ID);
/** Validate a Graph id used inside a query value; ids cannot contain quotes or separators. */
export const graphValue = (value: unknown) => GRAPH_ID.schema.parse(value) as string;

export const flag = (description: string): CatalogField => ({
  schema: z.boolean(), param: { type: "boolean", required: true, description },
});
export const optionalInteger = (minimum: number, maximum: number, description: string): CatalogField => {
  const field = optional(integer(minimum, maximum));
  return { schema: field.schema, param: { ...field.param, description } };
};
export const skipToken: CatalogField = { schema: CURSOR.schema, param: { ...CURSOR.param, description: "$skiptoken value from the previous page's @odata.nextLink" } };

export const subject: CatalogField = {
  schema: z.string().max(255).regex(NO_CONTROL),
  param: { type: "string", required: true, maxLength: 255, description: "Subject, at most 255 characters, no control characters" },
};
export const bodyHtml: CatalogField = {
  schema: z.string().max(MAX_BODY_HTML_CHARS),
  param: { type: "string", required: true, maxLength: MAX_BODY_HTML_CHARS, description: "Complete HTML body" },
};
const recipient = z.strictObject({
  address: z.email().max(254),
  name: z.string().min(1).max(128).regex(NO_CONTROL).optional(),
});
export const recipients: CatalogField = {
  schema: z.array(recipient).max(MAX_DRAFT_RECIPIENTS),
  param: { type: "array", required: true, description: "Recipients as [{ address, name? }]" },
};
export const filename: CatalogField = {
  schema: z.string().min(1).max(255).regex(/^[^/\\"\x00-\x1f\x7f]+$/),
  param: { type: "string", required: true, minLength: 1, maxLength: 255, description: "File name without path separators, quotes or control characters" },
};
export const mimeType: CatalogField = {
  schema: z.string().max(127).regex(/^[\w.+-]{1,63}\/[\w.+-]{1,63}$/),
  param: { type: "string", required: true, maxLength: 127, description: "MIME type such as application/pdf" },
};
export const base64Content: CatalogField = {
  schema: z.string().max(MAX_COMPOSE_REQUEST_BYTES)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  param: { type: "string", required: true, maxLength: MAX_COMPOSE_REQUEST_BYTES, description: "File content as standard padded base64" },
};

type Params = Record<string, unknown>;
export const RECIPIENT_KEYS = ["toRecipients", "ccRecipients", "bccRecipients"] as const;

export function recipientCount(params: Params): number {
  return RECIPIENT_KEYS.reduce((total, key) => total + (Array.isArray(params[key]) ? (params[key] as unknown[]).length : 0), 0);
}
export function withinComposeBudget(params: Params): boolean {
  return Buffer.byteLength(JSON.stringify(params), "utf8") <= MAX_COMPOSE_REQUEST_BYTES;
}
type Recipient = { address: string; name?: string };
export function toGraphRecipients(list: unknown): { emailAddress: Recipient }[] {
  return (list as Recipient[]).map(({ address, name }) => ({ emailAddress: name === undefined ? { address } : { address, name } }));
}
/** Copies only the recipient lists the caller supplied, in Graph's shape. */
export function graphRecipientFields(params: Params): Record<string, unknown> {
  return Object.fromEntries(RECIPIENT_KEYS.filter(key => params[key] !== undefined).map(key => [key, toGraphRecipients(params[key])]));
}
export const htmlBody = (content: unknown) => ({ contentType: "HTML", content });

/** One proxied Graph call with a strict schema derived from the same fields as the catalog metadata. */
export function mailAction(description: string, risk: "read" | "write", fields: Record<string, CatalogField>,
  directApi: DirectApi, refine?: (params: Params) => boolean): ServiceAction {
  const base = strictFields(fields);
  return {
    description, risk,
    params: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.param])),
    paramsSchema: refine ? base.refine(value => refine(value as Params)) : base,
    directApi,
  };
}
