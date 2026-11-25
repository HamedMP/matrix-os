import { optional, type CatalogField } from "./catalog-fields.js";
import {
  GRAPH_ME, IMMUTABLE_ID_HEADERS, MAX_DRAFT_RECIPIENTS, WRITE_ECHO_QUERY,
  base64Content, bodyHtml, filename, flag, graphId, graphPath, graphRecipientFields, htmlBody,
  mailAction, mimeType, recipientCount, recipients, subject, withinComposeBudget,
} from "./microsoft-mail-shared.js";
import type { ServiceAction } from "./types.js";

// Microsoft Graph v1.0 mail write contracts:
// https://learn.microsoft.com/graph/api/message-update
// https://learn.microsoft.com/graph/api/message-move
// https://learn.microsoft.com/graph/api/user-post-messages
// https://learn.microsoft.com/graph/api/message-createreply
// https://learn.microsoft.com/graph/api/message-send
// https://learn.microsoft.com/graph/api/message-post-attachments

type Params = Record<string, unknown>;

const messageId: CatalogField = { ...graphId, param: { ...graphId.param, description: "Immutable message id" } };
const draftId: CatalogField = { ...graphId, param: { ...graphId.param, description: "Immutable id of an unsent draft" } };
const optionalRecipients = optional(recipients);
const recipientFields = { toRecipients: optionalRecipients, ccRecipients: optionalRecipients, bccRecipients: optionalRecipients };
const composeLimits = (p: Params) => recipientCount(p) <= MAX_DRAFT_RECIPIENTS && withinComposeBudget(p);
const messageUrl = (p: Params, suffix = "") => `${GRAPH_ME}/messages/${graphPath(p, "messageId")}${suffix}`;
const DRAFT_FIELDS = ["subject", "bodyHtml", "toRecipients", "ccRecipients", "bccRecipients"] as const;

/** microsoft_outlook mail writes; register as a write map. None is destructive: removal is a recoverable move. */
export const MICROSOFT_MAIL_WRITE_ACTIONS: Record<string, Record<string, ServiceAction>> = {
  microsoft_outlook: {
    update_message: mailAction("Mark one message read or unread and flagged or not flagged after approval", "write", {
      messageId, isRead: optional(flag("Set read state")), flagged: optional(flag("Set follow-up flag")),
    }, {
      method: "PATCH", url: p => messageUrl(p, WRITE_ECHO_QUERY), staticHeaders: IMMUTABLE_ID_HEADERS,
      mapBody: p => ({
        ...(p.isRead !== undefined ? { isRead: p.isRead } : {}),
        ...(p.flagged !== undefined ? { flag: { flagStatus: p.flagged ? "flagged" : "notFlagged" } } : {}),
      }),
    }, p => p.isRead !== undefined || p.flagged !== undefined),
    move_message: mailAction("Move one message to another folder after approval; moving to deleteditems is a recoverable trash", "write", {
      messageId, destinationFolderId: { ...graphId, param: { ...graphId.param, description: "Folder id or a standard name such as archive or deleteditems" } },
    }, {
      method: "POST", url: p => messageUrl(p, `/move${WRITE_ECHO_QUERY}`), staticHeaders: IMMUTABLE_ID_HEADERS,
      mapBody: p => ({ destinationId: p.destinationFolderId }),
    }),
    create_html_draft: mailAction("Save a new HTML email draft with recipients after approval; it is not sent", "write", {
      ...recipientFields, subject, bodyHtml,
    }, {
      method: "POST", url: `${GRAPH_ME}/messages${WRITE_ECHO_QUERY}`, staticHeaders: IMMUTABLE_ID_HEADERS,
      mapBody: p => ({ subject: p.subject, body: htmlBody(p.bodyHtml), ...graphRecipientFields(p) }),
    }, composeLimits),
    create_reply_draft: mailAction("Save a reply or reply-all draft to one message after approval; the provider fills recipients and subject; it is not sent", "write", {
      messageId, replyAll: flag("Reply to all recipients instead of the sender only"), bodyHtml,
    }, {
      method: "POST", url: p => messageUrl(p, `/${p.replyAll === true ? "createReplyAll" : "createReply"}${WRITE_ECHO_QUERY}`),
      staticHeaders: IMMUTABLE_ID_HEADERS,
      mapBody: p => ({ message: { body: htmlBody(p.bodyHtml) } }),
    }, composeLimits),
    update_draft: mailAction("Change the subject, HTML body or recipients of one unsent draft after approval", "write", {
      messageId: draftId, subject: optional(subject), bodyHtml: optional(bodyHtml), ...recipientFields,
    }, {
      method: "PATCH", url: p => messageUrl(p, WRITE_ECHO_QUERY), staticHeaders: IMMUTABLE_ID_HEADERS,
      mapBody: p => ({
        ...(p.subject !== undefined ? { subject: p.subject } : {}),
        ...(p.bodyHtml !== undefined ? { body: htmlBody(p.bodyHtml) } : {}),
        ...graphRecipientFields(p),
      }),
    }, p => DRAFT_FIELDS.some(key => p[key] !== undefined) && composeLimits(p)),
    // A move, not the provider's delete: one call cannot prove the id is a draft,
    // and a move to Deleted Items is recoverable whatever the id points at.
    delete_draft: mailAction("Discard one draft after approval by moving it to Deleted Items (recoverable)", "write", { messageId: draftId }, {
      method: "POST", url: p => messageUrl(p, `/move${WRITE_ECHO_QUERY}`), staticHeaders: IMMUTABLE_ID_HEADERS,
      mapBody: () => ({ destinationId: "deleteditems" }),
    }),
    // Takes only an id: what is sent is exactly the stored draft the owner saw.
    send_draft: mailAction("Send one existing draft exactly as stored, only after explicit owner approval", "write", { messageId: draftId }, {
      method: "POST", url: p => messageUrl(p, "/send"), staticHeaders: IMMUTABLE_ID_HEADERS, mapBody: () => ({}),
    }),
    add_attachment: mailAction("Attach one small file to an unsent draft after approval; about 42 KiB per call", "write", {
      messageId: draftId, name: filename, contentType: mimeType, contentBase64: base64Content,
    }, {
      method: "POST", url: p => messageUrl(p, "/attachments"), staticHeaders: IMMUTABLE_ID_HEADERS,
      mapBody: p => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: p.name, contentType: p.contentType, contentBytes: p.contentBase64 }),
    }, withinComposeBudget),
  },
};
