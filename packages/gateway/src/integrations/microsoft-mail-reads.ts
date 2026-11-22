import { z } from "zod/v4";
import { text, type CatalogField } from "./catalog-fields.js";
import {
  GRAPH_ME, HTML_BODY_HEADERS, IMMUTABLE_ID_HEADERS, MESSAGE_FULL_SELECT, MESSAGE_SUMMARY_SELECT,
  graphId, graphPath, graphValue, mailAction, optionalGraphId, optionalInteger, skipToken,
} from "./microsoft-mail-shared.js";
import type { ServiceAction } from "./types.js";

type Params = Record<string, unknown>;

// The provider requires the sort field to appear in $filter first, so each
// filter is a fixed string chosen by enum; caller text never reaches $filter.
const FOLDER_FILTERS = {
  unread: "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
  flagged: "receivedDateTime ge 1900-01-01T00:00:00Z and flag/flagStatus eq 'flagged'",
  attachments: "receivedDateTime ge 1900-01-01T00:00:00Z and hasAttachments eq true",
} as const;
type FolderFilter = keyof typeof FOLDER_FILTERS;
const folderFilter: CatalogField = {
  schema: z.enum(Object.keys(FOLDER_FILTERS) as [FolderFilter, ...FolderFilter[]]).optional(),
  param: { type: "string", required: false, description: "Optional fixed filter: unread, flagged or attachments" },
};
const searchText = text(512, /^[^\x00-\x1f\x7f]+$/);
const searchQuery: CatalogField = {
  schema: searchText.schema, param: { ...searchText.param, description: "Search text, for example 'budget from:ada@example.com'" },
};
const includeBody: CatalogField = {
  schema: z.boolean().optional(),
  param: { type: "boolean", required: false, description: "Include HTML bodies (default true)" },
};
const folderId: CatalogField = { ...graphId, param: { ...graphId.param, description: "Folder id or a standard name such as inbox, sentitems or archive" } };
const messageId: CatalogField = { ...graphId, param: { ...graphId.param, description: "Immutable message id" } };

const FOLDER_SELECT = "id,displayName,parentFolderId,unreadItemCount,totalItemCount,childFolderCount";
const top = (p: Params) => String(p.top ?? 25);
const skip = (p: Params): Record<string, string> => (p.skip !== undefined ? { $skip: String(p.skip) } : {});
/** Graph KQL: wrap in double quotes and escape backslash and quote inside. */
export const quoteSearch = (query: string) => `"${query.replace(/[\\"]/g, char => `\\${char}`)}"`;

/** microsoft_outlook mail reads; spread into the microsoft_outlook service definition. */
export const MICROSOFT_MAIL_READ_ACTIONS: Record<string, ServiceAction> = {
  get_folder: mailAction("Read one mail folder's name and item counts by id or standard name", "read", { folderId }, {
    method: "GET", url: p => `${GRAPH_ME}/mailFolders/${graphPath(p, "folderId")}`,
    mapParams: () => ({ $select: FOLDER_SELECT }), staticHeaders: IMMUTABLE_ID_HEADERS,
  }),
  list_folder_messages: mailAction("List one page of message summaries in a folder, newest first", "read", {
    folderId, top: optionalInteger(1, 50, "Page size, default 25"), skip: optionalInteger(0, 5000, "Messages to skip"), filter: folderFilter,
  }, {
    method: "GET", url: p => `${GRAPH_ME}/mailFolders/${graphPath(p, "folderId")}/messages`,
    mapParams: p => ({
      $select: MESSAGE_SUMMARY_SELECT, $top: top(p), ...skip(p), $orderby: "receivedDateTime desc",
      ...(p.filter !== undefined ? { $filter: FOLDER_FILTERS[folderFilter.schema.parse(p.filter) as FolderFilter] as string } : {}),
    }),
    staticHeaders: IMMUTABLE_ID_HEADERS,
  }),
  search_messages: mailAction("Search messages, optionally within one folder; returns one page of summaries", "read", {
    query: searchQuery, folderId: optionalGraphId, top: optionalInteger(1, 50, "Page size, default 25"), skipToken,
  }, {
    method: "GET",
    url: p => (p.folderId === undefined ? `${GRAPH_ME}/messages` : `${GRAPH_ME}/mailFolders/${graphPath(p, "folderId")}/messages`),
    mapParams: p => ({
      $select: MESSAGE_SUMMARY_SELECT, $search: quoteSearch(searchQuery.schema.parse(p.query) as string), $top: top(p),
      ...(p.skipToken !== undefined ? { $skiptoken: skipToken.schema.parse(p.skipToken) as string } : {}),
    }),
    staticHeaders: IMMUTABLE_ID_HEADERS,
  }),
  list_conversation: mailAction("List the messages of one conversation, with HTML bodies unless includeBody is false", "read", {
    conversationId: graphId, top: optionalInteger(1, 50, "Page size, default 25"), skip: optionalInteger(0, 500, "Messages to skip"), includeBody,
  }, {
    method: "GET", url: `${GRAPH_ME}/messages`,
    mapParams: p => ({
      $filter: `conversationId eq '${graphValue(p.conversationId)}'`,
      $select: p.includeBody === false ? MESSAGE_SUMMARY_SELECT : MESSAGE_FULL_SELECT, $top: top(p), ...skip(p),
    }),
    staticHeaders: HTML_BODY_HEADERS,
  }),
  get_message: mailAction("Read one message with its HTML body and recipients", "read", { messageId }, {
    method: "GET", url: p => `${GRAPH_ME}/messages/${graphPath(p, "messageId")}`,
    mapParams: () => ({ $select: MESSAGE_FULL_SELECT }), staticHeaders: HTML_BODY_HEADERS,
  }),
  list_attachments: mailAction("List a message's attachments with name, type and size, without content", "read", { messageId }, {
    method: "GET", url: p => `${GRAPH_ME}/messages/${graphPath(p, "messageId")}/attachments`,
    mapParams: () => ({ $select: "id,name,contentType,size,isInline", $top: "50" }), staticHeaders: IMMUTABLE_ID_HEADERS,
  }),
  get_attachment: mailAction("Read one attachment including its base64 content; check its size with list_attachments first", "read", {
    messageId, attachmentId: { ...graphId, param: { ...graphId.param, description: "Attachment id" } },
  }, {
    method: "GET",
    url: p => `${GRAPH_ME}/messages/${graphPath(p, "messageId")}/attachments/${graphPath(p, "attachmentId")}`,
    staticHeaders: IMMUTABLE_ID_HEADERS,
  }),
};
