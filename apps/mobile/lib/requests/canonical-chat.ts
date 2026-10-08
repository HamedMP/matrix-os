import {
  CanonicalCancelChatRunRequestSchema,
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalCreateChatRequestSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalProviderCatalogSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

import { gatewayRequestUrl } from "@/lib/requests/answers";
import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const CHATS_UNAVAILABLE_ERROR = "Chats unavailable. Try again.";
const CHAT_CREATE_ERROR = "Could not start a new chat. Try again.";
const CHAT_DETAIL_ERROR = "Chat unavailable. Try again.";
const CHAT_TURN_ERROR = "Could not send message. Try again.";
const CHAT_SEARCH_ERROR = "Search unavailable. Try again.";
const RUN_CANCEL_ERROR = "Could not stop the run. Try again.";
const PROVIDER_CATALOG_ERROR = "Models unavailable. Try again.";
const CHAT_DETAIL_LIMIT = 200;
// The most the list and search routes return for one request.
const CHAT_PAGE_MAX = 100;
const CHAT_SEARCH_DEFAULT_LIMIT = 50;
const CHAT_SEARCH_QUERY_MAX = 200;
// Without this the gateway strips `readState` (unread) from every record.
const READ_STATE_VERSION = "1";

export interface ChatPageOptions {
  /** `nextCursor` of the page before this one; omit for the first page. */
  cursor?: string;
  /** 1 to 100; defaults to 100. */
  limit?: number;
}

function validPageSize(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= CHAT_PAGE_MAX;
}

// The list and search routes validate a project reference with this same schema.
function validProjectId(projectId: string): boolean {
  return CanonicalCreateChatRequestSchema.shape.projectId.safeParse(projectId).success;
}

function fetchChatPage(
  clerkToken: string,
  computerGatewayUrl: string,
  { cursor, limit = CHAT_PAGE_MAX, projectId }: ChatPageOptions & { projectId?: string },
): Promise<CanonicalChatListResponse> {
  const valid = validPageSize(limit)
    && (cursor === undefined || CanonicalChatApiCursorSchema.safeParse(cursor).success)
    && (projectId === undefined || validProjectId(projectId));
  const url = valid
    ? gatewayRequestUrl(computerGatewayUrl, "/api/chats", {
      limit: String(limit),
      readStateVersion: READ_STATE_VERSION,
      ...(projectId === undefined ? {} : { projectId }),
      ...(cursor === undefined ? {} : { cursor }),
    })
    : null;
  if (!url) return Promise.reject(new Error(CHATS_UNAVAILABLE_ERROR));
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalChatListResponseSchema,
    errorMessage: CHATS_UNAVAILABLE_ERROR,
  });
}

/**
 * One page of every chat, most recent activity first. A page that comes with
 * `nextCursor` has older chats after it, even when the page itself is empty.
 */
export function fetchChats(
  clerkToken: string,
  computerGatewayUrl: string,
  options: ChatPageOptions = {},
): Promise<CanonicalChatListResponse> {
  return fetchChatPage(clerkToken, computerGatewayUrl, { cursor: options.cursor, limit: options.limit });
}

/** One page of the chats in the project with this id (not its slug). */
export function fetchProjectChats(
  clerkToken: string,
  computerGatewayUrl: string,
  projectId: string,
  options: ChatPageOptions = {},
): Promise<CanonicalChatListResponse> {
  return fetchChatPage(clerkToken, computerGatewayUrl, { cursor: options.cursor, limit: options.limit, projectId });
}

export interface ChatSearchOptions {
  /** 1 to 100; defaults to 50. */
  limit?: number;
  /** Only chats in this project. */
  projectId?: string;
  /**
   * `"global"` is the server's name for chats that are in no project. Leave
   * both this and `projectId` out to search every chat.
   */
  scope?: "global";
}

/**
 * Chats with a message matching `query`, most recently updated first. The
 * server matches whole words in message text; it does not match titles or the
 * start of a word. An empty query has no results and makes no request.
 */
export async function searchChats(
  clerkToken: string,
  computerGatewayUrl: string,
  query: string,
  { limit = CHAT_SEARCH_DEFAULT_LIMIT, projectId, scope }: ChatSearchOptions = {},
): Promise<CanonicalChatRecord[]> {
  const text = query.trim().slice(0, CHAT_SEARCH_QUERY_MAX).trim();
  if (!text) return [];
  // The server rejects a project together with the outside-projects scope.
  const valid = validPageSize(limit)
    && !(scope !== undefined && projectId !== undefined)
    && (projectId === undefined || validProjectId(projectId));
  const url = valid
    ? gatewayRequestUrl(computerGatewayUrl, "/api/chats/search", {
      query: text,
      limit: String(limit),
      readStateVersion: READ_STATE_VERSION,
      ...(projectId === undefined ? {} : { projectId }),
      ...(scope === undefined ? {} : { scope }),
    })
    : null;
  if (!url) throw new Error(CHAT_SEARCH_ERROR);
  const response = await fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalChatListResponseSchema,
    errorMessage: CHAT_SEARCH_ERROR,
  });
  return response.items;
}

/**
 * Stops a run. `cancellation` is `"already_terminal"` when it had ended by
 * itself, which is as much a success as `"aborted"`.
 */
export async function cancelChatRun(
  clerkToken: string,
  computerGatewayUrl: string,
  chatId: string,
  runId: string,
  clientRequestId: string,
): Promise<CanonicalChatRunCancellationResponse> {
  const chat = CanonicalChatIdSchema.safeParse(chatId);
  const run = CanonicalChatRunIdSchema.safeParse(runId);
  const body = CanonicalCancelChatRunRequestSchema.safeParse({ clientRequestId });
  const url = chat.success && run.success && body.success
    ? gatewayRequestUrl(
      computerGatewayUrl,
      `/api/chats/${encodeURIComponent(chat.data)}/runs/${encodeURIComponent(run.data)}/cancel`,
    )
    : null;
  if (!url || !body.success) throw new Error(RUN_CANCEL_ERROR);
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalChatRunCancellationResponseSchema,
    errorMessage: RUN_CANCEL_ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body.data),
  });
}

/**
 * When the chat last had activity, which is what the server orders lists by.
 * These requests do not send the chat metadata header, and without it the
 * gateway carries the activity time in `updatedAt`; with it, in `activityAt`.
 */
export function chatActivityAt(record: CanonicalChatRecord): string {
  return record.chat.activityAt ?? record.chat.updatedAt;
}

/** A chat for which the server sent no read state counts as read. */
export function isChatUnread(record: CanonicalChatRecord): boolean {
  return record.readState?.unread ?? false;
}

export async function createChat(
  clerkToken: string,
  computerGatewayUrl: string,
  input: CanonicalCreateChatRequest,
): Promise<CanonicalChatRecord> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/chats");
  } catch {
    throw new Error(CHAT_CREATE_ERROR);
  }
  const body = CanonicalCreateChatRequestSchema.parse(input);
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalChatRecordSchema,
    errorMessage: CHAT_CREATE_ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchChatDetail(
  clerkToken: string,
  computerGatewayUrl: string,
  chatId: string,
): Promise<CanonicalChatDetailResponse> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(
      computerGatewayUrl,
      `/api/chats/${encodeURIComponent(chatId)}`,
      { limit: String(CHAT_DETAIL_LIMIT), fundingVersion: "1" },
    );
  } catch {
    return Promise.reject(new Error(CHAT_DETAIL_ERROR));
  }
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalChatDetailResponseSchema,
    errorMessage: CHAT_DETAIL_ERROR,
  });
}

export async function admitChatTurn(
  clerkToken: string,
  computerGatewayUrl: string,
  chatId: string,
  input: CanonicalCreateChatTurnRequest,
): Promise<CanonicalChatTurnAdmissionResponse> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(
      computerGatewayUrl,
      `/api/chats/${encodeURIComponent(chatId)}/turns`,
      { fundingVersion: "1" },
    );
  } catch {
    throw new Error(CHAT_TURN_ERROR);
  }
  const body = CanonicalCreateChatTurnRequestSchema.parse(input);
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalChatTurnAdmissionResponseSchema,
    errorMessage: CHAT_TURN_ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function fetchChatProviderCatalog(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<CanonicalProviderCatalog> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/chat-providers", {
      includeConnectionLabels: "true", includeConnectionState: "true", includeFundingState: "true", includeChatFunding: "true",
    });
  } catch {
    return Promise.reject(new Error(PROVIDER_CATALOG_ERROR));
  }
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalProviderCatalogSchema,
    errorMessage: PROVIDER_CATALOG_ERROR,
  });
}

export function canonicalChatRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const random = c && typeof c.randomUUID === "function"
    ? c.randomUUID().replaceAll("-", "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  return `req_${random}`;
}

/** Mirrors desktop's simple derivation: the first ~56 chars of the prompt. */
export function canonicalChatTitle(text: string): string {
  const visible = text.replace(/\s+/g, " ").trim();
  if (!visible) return "New chat";
  const maxLength = 56;
  const concise = visible.length > maxLength
    ? `${visible.slice(0, maxLength - 1).replace(/\s+\S*$/, "").trimEnd()}…`
    : visible;
  return /^[a-z]/.test(concise)
    ? `${concise[0]!.toUpperCase()}${concise.slice(1)}`
    : concise;
}
