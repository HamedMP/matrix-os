import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalCreateChatRequestSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalProviderCatalogSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

import { buildGatewayRequestUrl, fetchAuthenticatedJson } from "@/lib/requests/http";

const CHATS_UNAVAILABLE_ERROR = "Chats unavailable. Try again.";
const CHAT_CREATE_ERROR = "Could not start a new chat. Try again.";
const CHAT_DETAIL_ERROR = "Chat unavailable. Try again.";
const CHAT_TURN_ERROR = "Could not send message. Try again.";
const PROVIDER_CATALOG_ERROR = "Models unavailable. Try again.";
const CHAT_DETAIL_LIMIT = 200;

export function fetchChats(
  clerkToken: string,
  computerGatewayUrl: string,
): Promise<CanonicalChatListResponse> {
  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/chats", { limit: "100" });
  } catch {
    return Promise.reject(new Error(CHATS_UNAVAILABLE_ERROR));
  }
  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: CanonicalChatListResponseSchema,
    errorMessage: CHATS_UNAVAILABLE_ERROR,
  });
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
      { limit: String(CHAT_DETAIL_LIMIT) },
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
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/chat-providers");
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
