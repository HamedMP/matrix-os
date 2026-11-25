import { z } from "zod/v4";
import {
  MESSAGING_BRIDGE_OWNER_BASE_PATH,
  MatrixRoomIdSchema,
  MessagingBridgeConversationsQuerySchema,
  MessagingBridgeConversationsResponseSchema,
  MessagingBridgeErrorSchema,
  MessagingBridgeLinkProgressSchema,
  MessagingBridgeLinkStartRequestSchema,
  MessagingBridgeLinkStepRequestSchema,
  MessagingBridgeMessageSchema,
  MessagingBridgeMessagesQuerySchema,
  MessagingBridgeMessagesResponseSchema,
  MessagingBridgeNetworkSchema,
  MessagingBridgeSendRequestSchema,
  MessagingBridgeStatusSchema,
  type MessagingBridgeErrorCode,
  type MessagingBridgeLinkProgress,
  type MessagingBridgeMessage,
  type MessagingBridgeNetwork,
  type MessagingBridgeStatus,
} from "@matrix-os/contracts/messaging-bridge";

/** Surface adapters supply this: same-origin path in, Response out, with their own auth. */
export type MessagingBridgeFetch = (path: string, init: RequestInit) => Promise<Response>;

export const MESSAGING_BRIDGE_REQUEST_TIMEOUT_MS = 10_000;
export const MESSAGING_BRIDGE_LONG_POLL_TIMEOUT_MS = 35_000;
/** Starting a link waits for the bridge to open a login (up to about 40 s). */
export const MESSAGING_BRIDGE_LINK_START_TIMEOUT_MS = 45_000;

export type MessagingBridgeClientErrorCode =
  | MessagingBridgeErrorCode
  | "timeout"
  | "offline"
  | "aborted"
  | "invalid_response"
  | "unknown";

export const MESSAGING_BRIDGE_GENERIC_ERROR = "Something went wrong. Try again.";
const UNAVAILABLE = "Chat apps are unavailable right now. Try again soon.";

/** The only strings a bridge error can ever show. Server messages are never displayed. */
const ERROR_MESSAGES: Partial<Record<MessagingBridgeClientErrorCode, string>> = {
  unauthorized: "Your session has expired. Sign in again.",
  forbidden: "You do not have access to this.",
  not_enabled: "Chat apps are not available on your account yet.",
  not_found: "That item no longer exists. Refresh and try again.",
  invalid_request: "Check the details and try again.",
  conflict: "Something changed. Refresh and try again.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  bridge_unavailable: UNAVAILABLE,
  misconfigured: UNAVAILABLE,
  timeout: "The request timed out. Try again.",
  offline: "Can't reach your Matrix computer. Check your connection.",
};

export function messagingBridgeErrorMessage(code: MessagingBridgeClientErrorCode): string {
  return ERROR_MESSAGES[code] ?? MESSAGING_BRIDGE_GENERIC_ERROR;
}

export class MessagingBridgeClientError extends Error {
  readonly code: MessagingBridgeClientErrorCode;
  readonly userMessage: string;
  readonly httpStatus?: number;

  constructor(code: MessagingBridgeClientErrorCode, options?: { httpStatus?: number; cause?: unknown }) {
    const userMessage = messagingBridgeErrorMessage(code);
    super(userMessage, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MessagingBridgeClientError";
    this.code = code;
    this.userMessage = userMessage;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
  }
}

export function isBridgeAbort(error: unknown): boolean {
  return error instanceof MessagingBridgeClientError && error.code === "aborted";
}

/** Safe text for any thrown value: allowlisted copy for client errors, generic otherwise. */
export function bridgeErrorText(error: unknown): string {
  return error instanceof MessagingBridgeClientError ? error.userMessage : MESSAGING_BRIDGE_GENERIC_ERROR;
}

const STATUS_CODES: Record<number, MessagingBridgeErrorCode> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  503: "bridge_unavailable",
};

const OkSchema = z.strictObject({ ok: z.literal(true) });
const AccountIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:=-]+$/);

export type ConversationsQuery = { network?: MessagingBridgeNetwork; cursor?: string; limit?: number };
export type MessagesQuery = { cursor?: string; limit?: number };
export type LinkStepRequest = { stepId: string; fields?: Record<string, string> };
export type SendRequest = { body: string; clientTxnId: string };

export interface MessagingBridgeClient {
  status(signal?: AbortSignal): Promise<MessagingBridgeStatus>;
  startLink(network: MessagingBridgeNetwork, signal?: AbortSignal): Promise<MessagingBridgeLinkProgress>;
  linkStep(network: MessagingBridgeNetwork, linkId: string, body: LinkStepRequest, signal?: AbortSignal): Promise<MessagingBridgeLinkProgress>;
  /** Best-effort, idempotent abandonment of an unfinished link. */
  cancelLink(network: MessagingBridgeNetwork, linkId: string, signal?: AbortSignal): Promise<void>;
  removeAccount(network: MessagingBridgeNetwork, accountId: string, signal?: AbortSignal): Promise<void>;
  conversations(query?: ConversationsQuery, signal?: AbortSignal): Promise<z.infer<typeof MessagingBridgeConversationsResponseSchema>>;
  messages(roomId: string, query?: MessagesQuery, signal?: AbortSignal): Promise<z.infer<typeof MessagingBridgeMessagesResponseSchema>>;
  send(roomId: string, body: SendRequest, signal?: AbortSignal): Promise<MessagingBridgeMessage>;
}

const BASE = `${MESSAGING_BRIDGE_OWNER_BASE_PATH}/bridge`;

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MessagingBridgeClientError("invalid_request");
  return parsed.data;
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function createMessagingBridgeClient(fetchFn: MessagingBridgeFetch): MessagingBridgeClient {
  async function request<T>(
    schema: z.ZodType<T>,
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? MESSAGING_BRIDGE_REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchFn(path, {
        method,
        headers: options.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
        redirect: "error",
        cache: "no-store",
      });
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new MessagingBridgeClientError("aborted", { cause: error });
      if (timeout.aborted) throw new MessagingBridgeClientError("timeout", { cause: error });
      throw new MessagingBridgeClientError(error instanceof TypeError ? "offline" : "unknown", { cause: error });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      if (options.signal?.aborted) throw new MessagingBridgeClientError("aborted", { cause: error });
      if (response.ok) throw new MessagingBridgeClientError("invalid_response", { httpStatus: response.status, cause: error });
      body = undefined;
    }
    if (!response.ok) {
      const parsed = MessagingBridgeErrorSchema.safeParse(body);
      const code = parsed.success ? parsed.data.error.code : (STATUS_CODES[response.status] ?? "unknown");
      throw new MessagingBridgeClientError(code, { httpStatus: response.status });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new MessagingBridgeClientError("invalid_response", { httpStatus: response.status });
    return parsed.data;
  }

  const networkPath = (network: MessagingBridgeNetwork) => `${BASE}/${validated(MessagingBridgeNetworkSchema, network)}`;
  const roomPath = (roomId: string) => `${BASE}/conversations/${encodeURIComponent(validated(MatrixRoomIdSchema, roomId))}`;

  return {
    status: (signal) => request(MessagingBridgeStatusSchema, "GET", `${BASE}/status`, { signal }),
    startLink: async (network, signal) =>
      request(MessagingBridgeLinkProgressSchema, "POST", `${networkPath(network)}/link`, {
        body: validated(MessagingBridgeLinkStartRequestSchema, {}),
        signal,
        timeoutMs: MESSAGING_BRIDGE_LINK_START_TIMEOUT_MS,
      }),
    linkStep: async (network, linkId, body, signal) => {
      const payload = validated(MessagingBridgeLinkStepRequestSchema, body);
      return request(
        MessagingBridgeLinkProgressSchema,
        "POST",
        `${networkPath(network)}/link/${encodeURIComponent(validated(AccountIdSchema, linkId))}/step`,
        {
          body: payload,
          signal,
          timeoutMs: payload.fields === undefined ? MESSAGING_BRIDGE_LONG_POLL_TIMEOUT_MS : MESSAGING_BRIDGE_REQUEST_TIMEOUT_MS,
        },
      );
    },
    cancelLink: async (network, linkId, signal) => {
      await request(OkSchema, "POST", `${networkPath(network)}/link/${encodeURIComponent(validated(AccountIdSchema, linkId))}/cancel`, { signal });
    },
    removeAccount: async (network, accountId, signal) => {
      await request(
        OkSchema,
        "DELETE",
        `${networkPath(network)}/accounts/${encodeURIComponent(validated(AccountIdSchema, accountId))}`,
        { signal },
      );
    },
    conversations: async (query = {}, signal) => {
      const q = validated(MessagingBridgeConversationsQuerySchema, query);
      return request(
        MessagingBridgeConversationsResponseSchema,
        "GET",
        `${BASE}/conversations${queryString({ network: q.network, cursor: q.cursor, limit: q.limit })}`,
        { signal },
      );
    },
    messages: async (roomId, query = {}, signal) => {
      const path = roomPath(roomId);
      const q = validated(MessagingBridgeMessagesQuerySchema, query);
      return request(MessagingBridgeMessagesResponseSchema, "GET", `${path}/messages${queryString({ cursor: q.cursor, limit: q.limit })}`, { signal });
    },
    send: async (roomId, body, signal) => {
      const path = roomPath(roomId);
      return request(MessagingBridgeMessageSchema, "POST", `${path}/send`, {
        body: validated(MessagingBridgeSendRequestSchema, body),
        signal,
      });
    },
  };
}
