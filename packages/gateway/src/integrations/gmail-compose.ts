import { z } from "zod/v4";
import {
  BASE64, SAFE_ADDRESS, SAFE_FILENAME, SAFE_MESSAGE_ID, SAFE_MIME_TYPE, buildGmailRaw, type MimeMessageInput,
} from "./gmail-mime.js";
import type { ActionParam, ServiceAction } from "./types.js";

/**
 * Gmail compose and triage actions for the Mail app (spec 2710,
 * integration-actions.md section 5). Every action is one proxied call
 * (`directApi`); path and query values are validated before they are encoded.
 *
 * Registration: `GMAIL_COMPOSE_WRITE_ACTIONS` is a write map keyed by service
 * id; `GMAIL_COMPOSE_READ_ACTIONS` is spread into the `gmail` definition.
 */

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Whole-request budget shared with the app capability limit (64 KiB minus framing). */
export const GMAIL_MAX_COMPOSE_REQUEST_BYTES = 60_000;
export const GMAIL_MAX_RECIPIENTS = 100;
export const GMAIL_MAX_ATTACHMENTS = 10;
export const GMAIL_MAX_BODY_CHARS = 60_000;
/** Reply cap the wiring owner registers for `gmail/get_thread` (full bodies). */
export const GMAIL_THREAD_REPLY_BYTES = 1_572_864;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
const LONE_SURROGATE = /\p{Cs}/u;
/** Labels the provider owns; callers may never add or remove them. */
const PROVIDER_OWNED_LABELS: ReadonlySet<string> = new Set(["DRAFT", "SENT"]);

const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const noControl = (value: string) => !CONTROL.test(value) && !LONE_SURROGATE.test(value);
const fitsRequest = (params: unknown) => {
  try {
    return Buffer.byteLength(JSON.stringify(params), "utf8") <= GMAIL_MAX_COMPOSE_REQUEST_BYTES;
  } catch (error) {
    // Only circular or BigInt input reaches here; neither is a valid request.
    if (error instanceof TypeError) return false;
    throw error;
  }
};

const gmailId = z.string().min(1).max(128).regex(ID_PATTERN);
const pageToken = z.string().min(1).max(2048).regex(/^[^\s\x00-\x1f\x7f]+$/);
const searchQuery = z.string().max(4096).refine(noControl);
const resultCount = z.number().int().min(1).max(100);
const messageIdHeader = z.string().regex(SAFE_MESSAGE_ID);
const recipient = z.strictObject({
  address: z.email().max(254).regex(SAFE_ADDRESS),
  name: z.string().min(1).max(128).refine(noControl).optional(),
});
const recipientList = z.array(recipient).max(GMAIL_MAX_RECIPIENTS);
const attachment = z.strictObject({
  filename: z.string().regex(SAFE_FILENAME),
  mimeType: z.string().regex(SAFE_MIME_TYPE),
  contentBase64: z.string().regex(BASE64),
});
const mutableLabel = gmailId.refine((id) => !PROVIDER_OWNED_LABELS.has(id));
const labelList = z.array(mutableLabel).max(20).refine(unique);

const draftShape = {
  to: recipientList.optional(),
  cc: recipientList.optional(),
  bcc: recipientList.optional(),
  subject: z.string().max(255).refine(noControl),
  bodyHtml: z.string().max(GMAIL_MAX_BODY_CHARS),
  bodyText: z.string().max(GMAIL_MAX_BODY_CHARS),
  attachments: z.array(attachment).max(GMAIL_MAX_ATTACHMENTS).optional(),
};
const threadingShape = {
  threadId: gmailId,
  inReplyTo: messageIdHeader,
  references: z.array(messageIdHeader).max(20).optional(),
};

type DraftParams = {
  to?: readonly unknown[]; cc?: readonly unknown[]; bcc?: readonly unknown[];
};
const withinRecipientLimit = (p: DraftParams) =>
  (p.to?.length ?? 0) + (p.cc?.length ?? 0) + (p.bcc?.length ?? 0) <= GMAIL_MAX_RECIPIENTS;

const createHtmlDraftSchema = z.strictObject(draftShape)
  .refine(withinRecipientLimit).refine(fitsRequest);
const createReplyDraftSchema = z.strictObject({ ...draftShape, ...threadingShape })
  .refine(withinRecipientLimit).refine(fitsRequest);
const updateDraftSchema = z.strictObject({
  draftId: gmailId,
  ...draftShape,
  threadId: threadingShape.threadId.optional(),
  inReplyTo: threadingShape.inReplyTo.optional(),
  references: threadingShape.references,
}).refine(withinRecipientLimit).refine(fitsRequest);
const draftIdSchema = z.strictObject({ draftId: gmailId });
const batchModifySchema = z.strictObject({
  messageIds: z.array(gmailId).min(1).max(100).refine(unique),
  addLabelIds: labelList.optional(),
  removeLabelIds: labelList.optional(),
})
  .refine((p) => (p.addLabelIds?.length ?? 0) + (p.removeLabelIds?.length ?? 0) > 0)
  .refine((p) => !p.addLabelIds?.some((id) => p.removeLabelIds?.includes(id)));
const getThreadSchema = z.strictObject({ threadId: gmailId, format: z.enum(["full", "summary"]).optional() });
const getLabelSchema = z.strictObject({ labelId: gmailId });
const listDraftsSchema = z.strictObject({
  query: searchQuery.optional(), maxResults: resultCount.optional(), pageToken: pageToken.optional(),
});
const listThreadsQuerySchema = z.strictObject({
  query: searchQuery.optional(),
  labelIds: z.array(gmailId).max(10).refine(unique).optional(),
  maxResults: resultCount.optional(),
  pageToken: pageToken.optional(),
});

// ---- Parameter metadata for the agent catalog and the app route ----------

const idParam = (description: string): ActionParam => ({
  type: "string", required: true, minLength: 1, maxLength: 128, pattern: ID_PATTERN.source, description,
});
const recipientsParam = (field: string): ActionParam => ({
  type: "array", description: `${field} recipients: [{ address, name? }]; at most 100 across To, Cc and Bcc`,
});
const draftParams: Record<string, ActionParam> = {
  to: recipientsParam("To"),
  cc: recipientsParam("Cc"),
  bcc: recipientsParam("Bcc"),
  subject: { type: "string", required: true, maxLength: 255, description: "Subject line; may be empty" },
  bodyHtml: { type: "string", required: true, maxLength: GMAIL_MAX_BODY_CHARS, description: "HTML body" },
  bodyText: { type: "string", required: true, maxLength: GMAIL_MAX_BODY_CHARS, description: "Plain-text body" },
  attachments: {
    type: "array",
    description: "Up to 10 files: [{ filename, mimeType, contentBase64 }]; the whole request must fit in 60,000 bytes",
  },
};
const threadingParams: Record<string, ActionParam> = {
  threadId: idParam("Thread the reply belongs to"),
  inReplyTo: { type: "string", required: true, maxLength: 997, description: "Message-ID header of the message being answered, in angle brackets" },
  references: { type: "array", description: "Up to 20 Message-ID headers of the thread, oldest first" },
};
const pagingParams: Record<string, ActionParam> = {
  query: { type: "string", maxLength: 4096, description: "Gmail search query" },
  maxResults: { type: "number", minimum: 1, maximum: 100, description: "Page size (default 25)" },
  pageToken: { type: "string", minLength: 1, maxLength: 2048, description: "nextPageToken from the previous page" },
};

// ---- Request mapping -----------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const FULL_FIELDS = "id,historyId,messages(id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload)";
const PART_SUMMARY = "mimeType,filename,body(size,attachmentId)";
const SUMMARY_FIELDS = "id,historyId,messages(id,threadId,labelIds,snippet,internalDate,sizeEstimate,"
  + `payload(mimeType,filename,headers,body(size,attachmentId),parts(${PART_SUMMARY},parts(${PART_SUMMARY}))))`;

const pathId = (value: unknown) => encodeURIComponent(gmailId.parse(value));

function mimeInput(p: Record<string, unknown>): MimeMessageInput {
  const draft = p as Partial<MimeMessageInput>;
  return {
    ...(draft.to ? { to: draft.to } : {}),
    ...(draft.cc ? { cc: draft.cc } : {}),
    ...(draft.bcc ? { bcc: draft.bcc } : {}),
    subject: String(draft.subject ?? ""),
    bodyText: String(draft.bodyText ?? ""),
    bodyHtml: String(draft.bodyHtml ?? ""),
    ...(draft.attachments ? { attachments: draft.attachments } : {}),
    ...(draft.inReplyTo !== undefined ? { inReplyTo: draft.inReplyTo } : {}),
    ...(draft.references?.length ? { references: draft.references } : {}),
  };
}

function draftResource(p: Record<string, unknown>): Record<string, unknown> {
  const threadId = p.threadId === undefined ? undefined : gmailId.parse(p.threadId);
  return { message: { raw: buildGmailRaw(mimeInput(p)), ...(threadId ? { threadId } : {}) } };
}

function listThreadsUrl(params: Record<string, unknown>): string {
  const p = listThreadsQuerySchema.parse(params);
  const query = [
    ...(p.labelIds ?? []).map((id) => `labelIds=${encodeURIComponent(id)}`),
    ...(p.query ? [`q=${encodeURIComponent(p.query)}`] : []),
    `maxResults=${p.maxResults ?? DEFAULT_PAGE_SIZE}`,
    ...(p.pageToken ? [`pageToken=${encodeURIComponent(p.pageToken)}`] : []),
    // The provider leaves trash and spam out of label listings unless asked.
    ...(p.labelIds?.some((id) => id === "TRASH" || id === "SPAM") ? ["includeSpamTrash=true"] : []),
  ];
  return `${BASE}/threads?${query.join("&")}`;
}

function listDraftsParams(params: Record<string, unknown>): Record<string, string> {
  const p = listDraftsSchema.parse(params);
  return {
    ...(p.query ? { q: p.query } : {}),
    maxResults: String(p.maxResults ?? DEFAULT_PAGE_SIZE),
    ...(p.pageToken ? { pageToken: p.pageToken } : {}),
  };
}

function getThreadUrl(params: Record<string, unknown>): string {
  const format = params.format === undefined ? "full" : getThreadSchema.shape.format.parse(params.format);
  const fields = format === "summary" ? SUMMARY_FIELDS : FULL_FIELDS;
  return `${BASE}/threads/${pathId(params.threadId)}?format=full&fields=${fields}`;
}

function batchModifyBody(params: Record<string, unknown>): Record<string, unknown> {
  const p = batchModifySchema.parse(params);
  return {
    ids: p.messageIds,
    ...(p.addLabelIds?.length ? { addLabelIds: p.addLabelIds } : {}),
    ...(p.removeLabelIds?.length ? { removeLabelIds: p.removeLabelIds } : {}),
  };
}

// ---- Action maps ---------------------------------------------------------

export const GMAIL_COMPOSE_READ_ACTIONS: Record<string, ServiceAction> = {
  list_threads_query: {
    description: "List threads matching a Gmail search query and/or label ids, newest first (default 25 per page)",
    risk: "read",
    params: {
      query: pagingParams.query!,
      labelIds: { type: "array", description: "Up to 10 label ids; all must match" },
      maxResults: pagingParams.maxResults!,
      pageToken: pagingParams.pageToken!,
    },
    paramsSchema: listThreadsQuerySchema,
    directApi: { method: "GET", url: listThreadsUrl },
  },
  get_thread: {
    description: "Get one thread with every message: full bodies, or headers and the part tree only with format=summary",
    risk: "read",
    params: {
      threadId: idParam("Thread id"),
      format: { type: "string", description: "full (default) or summary" },
    },
    paramsSchema: getThreadSchema,
    directApi: { method: "GET", url: getThreadUrl },
  },
  get_label: {
    description: "Get one label with its message and thread counts, including unread counts",
    risk: "read",
    params: { labelId: idParam("Label id, for example INBOX") },
    paramsSchema: getLabelSchema,
    directApi: { method: "GET", url: (p) => `${BASE}/labels/${pathId(p.labelId)}` },
  },
  list_drafts: {
    description: "List unsent drafts, optionally filtered by a Gmail search query (default 25 per page)",
    risk: "read",
    params: pagingParams,
    paramsSchema: listDraftsSchema,
    directApi: { method: "GET", url: `${BASE}/drafts`, mapParams: listDraftsParams },
  },
};

const GMAIL_WRITES: Record<string, ServiceAction> = {
  create_html_draft: {
    description: "Save a new draft with an HTML and plain-text body, recipients and attachments. Nothing is sent",
    risk: "write",
    params: draftParams,
    paramsSchema: createHtmlDraftSchema,
    directApi: { method: "POST", url: `${BASE}/drafts`, mapBody: draftResource },
  },
  create_reply_draft: {
    description: "Save a reply draft in an existing thread with In-Reply-To and References headers. Nothing is sent",
    risk: "write",
    params: { ...draftParams, ...threadingParams },
    paramsSchema: createReplyDraftSchema,
    directApi: { method: "POST", url: `${BASE}/drafts`, mapBody: draftResource },
  },
  update_draft: {
    description: "Replace the whole content of an unsent draft, attachments included. Nothing is sent",
    risk: "write",
    params: {
      draftId: idParam("Draft id"),
      ...draftParams,
      threadId: { ...threadingParams.threadId!, required: false },
      inReplyTo: { ...threadingParams.inReplyTo!, required: false },
      references: threadingParams.references!,
    },
    paramsSchema: updateDraftSchema,
    directApi: { method: "PUT", url: (p) => `${BASE}/drafts/${pathId(p.draftId)}`, mapBody: draftResource },
  },
  delete_draft: {
    description: "Permanently discard an unsent draft. Draft ids cannot reach received or sent mail",
    risk: "write",
    params: { draftId: idParam("Draft id") },
    paramsSchema: draftIdSchema,
    directApi: { method: "DELETE", url: (p) => `${BASE}/drafts/${pathId(p.draftId)}` },
  },
  send_draft: {
    description: "Send a stored draft exactly as saved. Takes only the draft id",
    risk: "write",
    params: { draftId: idParam("Draft id") },
    paramsSchema: draftIdSchema,
    directApi: { method: "POST", url: `${BASE}/drafts/send`, mapBody: (p) => ({ id: gmailId.parse(p.draftId) }) },
  },
  batch_modify: {
    description: "Add or remove labels on up to 100 messages (archive, read state, star, move to trash or spam). DRAFT and SENT cannot change",
    risk: "write",
    params: {
      messageIds: { type: "array", required: true, description: "1 to 100 message ids" },
      addLabelIds: { type: "array", description: "Up to 20 label ids to add; TRASH and SPAM allowed" },
      removeLabelIds: { type: "array", description: "Up to 20 label ids to remove" },
    },
    paramsSchema: batchModifySchema,
    directApi: { method: "POST", url: `${BASE}/messages/batchModify`, mapBody: batchModifyBody },
  },
};

/** Write map keyed by service id, merged by `integrationWriteActions`. */
export const GMAIL_COMPOSE_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = { gmail: GMAIL_WRITES };

/** Per-action reply caps (bytes) above the 256 KiB default. */
export const GMAIL_COMPOSE_REPLY_BYTES: Readonly<Record<string, number>> = {
  "gmail/get_thread": GMAIL_THREAD_REPLY_BYTES,
};
