import {
  CanonicalAcknowledgeChatCompletionRequestSchema,
  CanonicalCancelChatRunRequestSchema,
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatStreamServerFrameSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatTurnIdSchema,
  CanonicalCreateChatRequestSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  CanonicalUpdateChatProjectRequestSchema,
  CanonicalUpdateChatUserStateRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatStreamEvent,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalChatApprovalSubmissionResponse,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCancelChatRunRequest,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalSubmitChatApprovalRequest,
  type CanonicalRetryChatTurnRequest,
  type CanonicalUpdateChatProjectRequest,
  type CanonicalUpdateChatUserStateRequest,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ApiClient } from "./api";

const CanonicalChatListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  lifecycle: z.enum(["active", "archived"]).optional(),
  projectId: CanonicalCreateChatRequestSchema.shape.projectId.nullable().optional(),
  cursor: CanonicalChatApiCursorSchema.optional(),
}).strict();

const CanonicalChatSearchInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  projectId: CanonicalCreateChatRequestSchema.shape.projectId.nullable().optional(),
}).strict();

const CanonicalChatDetailInputSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  cursor: CanonicalChatApiCursorSchema.optional(),
}).strict();

const CanonicalChatWebSocketTokenSchema = z.string().min(1).max(4096);
const DEFAULT_MAX_CHAT_EVENT_CONSUMERS = 16;
const DEFAULT_MAX_SEEN_CHAT_EVENT_CURSORS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
const MAX_CHAT_EVENT_FRAME_CHARS = 16 * 1024;

export type CanonicalChatInvalidation =
  | {
      type: "chat.changed";
      chatId: string;
      cursor: number;
      revision: number;
      eventType: CanonicalChatStreamEvent["eventType"];
    }
  | { type: "chat.full_refresh"; cursor?: number };

export type CanonicalChatEventConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "disposed";

export interface DesktopCanonicalChatWebSocket {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface CanonicalChatEventSource {
  subscribe(listener: (event: CanonicalChatInvalidation) => void): { dispose(): void };
  subscribeConnectionState(listener: () => void): { dispose(): void };
  connectionState(): CanonicalChatEventConnectionState;
  start(): Promise<void>;
  dispose(): void;
  activeInvalidationConsumerCount(): number;
}

export type CanonicalChatEventConsumer = Pick<CanonicalChatEventSource, "subscribe">
  & Partial<Pick<CanonicalChatEventSource, "subscribeConnectionState" | "connectionState">>;

function createBoundedLocalConsumerRegistry<T>(options: {
  maxConsumers: number;
  limitMessage: string;
  deliveryFailureMessage: string;
}) {
  const consumers: T[] = [];
  return {
    subscribe(consumer: T) {
      if (consumers.length >= options.maxConsumers) throw new Error(options.limitMessage);
      consumers.push(consumer);
      let subscribed = true;
      return {
        dispose() {
          if (!subscribed) return;
          subscribed = false;
          const index = consumers.indexOf(consumer);
          if (index >= 0) consumers.splice(index, 1);
        },
      };
    },
    notify(deliver: (consumer: T) => void) {
      for (const consumer of [...consumers]) {
        try {
          deliver(consumer);
        } catch (error: unknown) {
          console.warn(
            options.deliveryFailureMessage,
            error instanceof Error ? error.name : "UnknownError",
          );
        }
      }
    },
    clear: () => { consumers.length = 0; },
    size: () => consumers.length,
  };
}

export function createCanonicalChatEventSource(options: {
  gatewayOrigin: string;
  runtimeSlot?: string;
  fetchWebSocketToken(): Promise<string>;
  createWebSocket(url: string): DesktopCanonicalChatWebSocket;
  maxConsumers?: number;
  maxSeenCursors?: number;
  maxReconnectDelayMs?: number;
  setTimeoutFn?: (callback: () => void, delay: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}): CanonicalChatEventSource {
  const seenCursors = new Map<number, true>();
  const maxConsumers = Math.max(1, Math.min(
    options.maxConsumers ?? DEFAULT_MAX_CHAT_EVENT_CONSUMERS,
    DEFAULT_MAX_CHAT_EVENT_CONSUMERS,
  ));
  const consumers = createBoundedLocalConsumerRegistry<
    (event: CanonicalChatInvalidation) => void
  >({
    maxConsumers,
    limitMessage: "Chat event consumer limit reached",
    deliveryFailureMessage: "[canonical-chat] event consumer failed:",
  });
  const connectionStateConsumers = createBoundedLocalConsumerRegistry<() => void>({
    maxConsumers,
    limitMessage: "Chat connection-state consumer limit reached",
    deliveryFailureMessage: "[canonical-chat] connection-state consumer failed:",
  });
  const maxSeenCursors = Math.max(1, Math.min(
    options.maxSeenCursors ?? DEFAULT_MAX_SEEN_CHAT_EVENT_CURSORS,
    DEFAULT_MAX_SEEN_CHAT_EVENT_CURSORS,
  ));
  const maxReconnectDelayMs = Math.max(1, Math.min(
    options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
    DEFAULT_MAX_RECONNECT_DELAY_MS,
  ));
  const setTimeoutFn = options.setTimeoutFn ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  let socket: DesktopCanonicalChatWebSocket | null = null;
  let reconnectTimer: unknown;
  let reconnectAttempt = 0;
  let lastCursor: number | undefined;
  let replayGap = false;
  let started = false;
  let disposed = false;
  let connectionGeneration = 0;
  let currentConnectionState: CanonicalChatEventConnectionState = "idle";

  const setConnectionState = (next: CanonicalChatEventConnectionState) => {
    if (next === currentConnectionState) return;
    currentConnectionState = next;
    connectionStateConsumers.notify((consumer) => consumer());
  };

  const emit = (event: CanonicalChatInvalidation) => {
    consumers.notify((consumer) => consumer(event));
  };

  const rememberCursor = (cursor: number): boolean => {
    if (seenCursors.has(cursor)) return false;
    seenCursors.set(cursor, true);
    while (seenCursors.size > maxSeenCursors) {
      const oldest = seenCursors.keys().next().value;
      if (typeof oldest !== "number") break;
      seenCursors.delete(oldest);
    }
    return true;
  };

  const closeSocket = (target: DesktopCanonicalChatWebSocket | null) => {
    if (!target) return;
    target.onopen = null;
    target.onmessage = null;
    target.onerror = null;
    target.onclose = null;
    try {
      target.close();
    } catch (error: unknown) {
      console.warn(
        "[canonical-chat] event socket close failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  };

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer !== undefined) return;
    setConnectionState("reconnecting");
    const delay = Math.min(250 * (2 ** reconnectAttempt), maxReconnectDelayMs);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    const generation = ++connectionGeneration;
    let token: string;
    try {
      token = CanonicalChatWebSocketTokenSchema.parse(await options.fetchWebSocketToken());
    } catch (error: unknown) {
      console.warn(
        "[canonical-chat] event stream credential unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
      scheduleReconnect();
      return;
    }
    if (disposed || generation !== connectionGeneration) return;

    let url: URL;
    try {
      url = new URL("/ws/chats/events", options.gatewayOrigin);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("invalid origin");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", token);
      if (options.runtimeSlot && options.runtimeSlot !== "primary") {
        url.searchParams.set("runtime", options.runtimeSlot);
      }
      if (lastCursor !== undefined) url.searchParams.set("cursor", String(lastCursor));
    } catch (error: unknown) {
      console.warn(
        "[canonical-chat] event stream origin unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
      scheduleReconnect();
      return;
    }

    let nextSocket: DesktopCanonicalChatWebSocket;
    try {
      nextSocket = options.createWebSocket(url.toString());
    } catch (error: unknown) {
      console.warn(
        "[canonical-chat] event stream connection unavailable:",
        error instanceof Error ? error.name : "UnknownError",
      );
      scheduleReconnect();
      return;
    }
    if (disposed || generation !== connectionGeneration) {
      closeSocket(nextSocket);
      return;
    }
    socket = nextSocket;
    nextSocket.onmessage = (message) => {
      if (socket !== nextSocket || typeof message.data !== "string") return;
      if (message.data.length > MAX_CHAT_EVENT_FRAME_CHARS) {
        console.warn("[canonical-chat] event stream frame exceeded limit");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(message.data);
      } catch (error: unknown) {
        console.warn(
          "[canonical-chat] event stream sent invalid JSON:",
          error instanceof Error ? error.name : "UnknownError",
        );
        return;
      }
      const parsed = CanonicalChatStreamServerFrameSchema.safeParse(value);
      if (!parsed.success) {
        console.warn("[canonical-chat] event stream sent invalid frame");
        return;
      }
      const frame = parsed.data;
      if (frame.type === "chat.stream.attached") {
        reconnectAttempt = 0;
        setConnectionState("open");
        return;
      }
      if (frame.type === "chat.replay.gap") {
        replayGap = true;
        return;
      }
      if (frame.type === "chat.replay.end") {
        lastCursor = frame.nextCursor;
        reconnectAttempt = 0;
        emit({
          type: "chat.full_refresh",
          ...(frame.nextCursor === undefined ? {} : { cursor: frame.nextCursor }),
        });
        replayGap = false;
        return;
      }
      if (frame.type === "chat.event") {
        lastCursor = frame.event.cursor;
        if (!rememberCursor(frame.event.cursor)) return;
        emit({
          type: "chat.changed",
          chatId: frame.event.chatId,
          cursor: frame.event.cursor,
          revision: frame.event.revision,
          eventType: frame.event.eventType,
        });
        return;
      }
      if (frame.type === "chat.stream.closing") {
        setConnectionState("reconnecting");
        nextSocket.close();
        return;
      }
      if (frame.type === "chat.stream.error") {
        if (replayGap) replayGap = false;
        if (frame.error.retryable) {
          setConnectionState("reconnecting");
          nextSocket.close();
        }
      }
    };
    nextSocket.onerror = () => {
      console.warn("[canonical-chat] event stream connection failed");
      setConnectionState("reconnecting");
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      scheduleReconnect();
    };
  };

  return {
    subscribe(listener) {
      if (disposed) throw new Error("Chat event source is disposed");
      return consumers.subscribe(listener);
    },
    subscribeConnectionState(listener) {
      if (disposed) throw new Error("Chat event source is disposed");
      return connectionStateConsumers.subscribe(listener);
    },
    connectionState: () => currentConnectionState,
    async start() {
      if (started || disposed) return;
      started = true;
      setConnectionState("connecting");
      await connect();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      connectionGeneration += 1;
      if (reconnectTimer !== undefined) {
        clearTimeoutFn(reconnectTimer);
        reconnectTimer = undefined;
      }
      const currentSocket = socket;
      socket = null;
      closeSocket(currentSocket);
      consumers.clear();
      seenCursors.clear();
      setConnectionState("disposed");
      connectionStateConsumers.clear();
    },
    activeInvalidationConsumerCount: () => consumers.size(),
  };
}

export interface CanonicalChatClient {
  list(input?: z.input<typeof CanonicalChatListInputSchema>): Promise<CanonicalChatListResponse>;
  search(
    query: string,
    input?: z.input<typeof CanonicalChatSearchInputSchema>,
  ): Promise<CanonicalChatListResponse>;
  create(input: CanonicalCreateChatRequest): Promise<CanonicalChatRecord>;
  updateProject(chatId: string, input: CanonicalUpdateChatProjectRequest): Promise<CanonicalChatRecord>;
  updateUserState(chatId: string, input: CanonicalUpdateChatUserStateRequest): Promise<CanonicalChatRecord>;
  acknowledgeCompletion(chatId: string, runId: string): Promise<CanonicalChatRecord>;
  delete(chatId: string, clientRequestId: string): Promise<{ chatId: string; deletedAt: string }>;
  getDetail(
    chatId: string,
    input?: z.input<typeof CanonicalChatDetailInputSchema>,
  ): Promise<CanonicalChatDetailResponse>;
  admitTurn(chatId: string, input: CanonicalCreateChatTurnRequest): Promise<CanonicalChatTurnAdmissionResponse>;
  cancelRun(
    chatId: string,
    runId: string,
    input: CanonicalCancelChatRunRequest,
  ): Promise<CanonicalChatRunCancellationResponse>;
  submitApproval(
    chatId: string,
    runId: string,
    approvalId: string,
    input: CanonicalSubmitChatApprovalRequest,
  ): Promise<CanonicalChatApprovalSubmissionResponse>;
  retryTurn(
    chatId: string,
    turnId: string,
    input: CanonicalRetryChatTurnRequest,
  ): Promise<CanonicalChatRunAdmissionResponse>;
}

function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function createCanonicalChatClient(
  api: Pick<ApiClient, "get" | "post" | "patch" | "delete">,
): CanonicalChatClient {
  return {
    async list(input = {}) {
      const parsed = CanonicalChatListInputSchema.parse(input);
      const response = await api.get(withQuery("/api/chats", {
        limit: parsed.limit,
        lifecycle: parsed.lifecycle,
        projectId: parsed.projectId ?? undefined,
        scope: parsed.projectId === null ? "global" : undefined,
        cursor: parsed.cursor,
      }));
      return CanonicalChatListResponseSchema.parse(response);
    },

    async search(query, input = {}) {
      const parsedQuery = z.string().trim().min(1).max(200).parse(query);
      const parsed = CanonicalChatSearchInputSchema.parse(input);
      const response = await api.get(withQuery("/api/chats/search", {
        query: parsedQuery,
        limit: parsed.limit,
        projectId: parsed.projectId ?? undefined,
        scope: parsed.projectId === null ? "global" : undefined,
      }));
      return CanonicalChatListResponseSchema.parse(response);
    },

    async create(input) {
      const parsed = CanonicalCreateChatRequestSchema.parse(input);
      return CanonicalChatRecordSchema.parse(await api.post("/api/chats", parsed));
    },

    async updateProject(chatId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const request = CanonicalUpdateChatProjectRequestSchema.parse(input);
      return CanonicalChatRecordSchema.parse(await api.patch(
        `/api/chats/${encodeURIComponent(parsedChatId)}/project`,
        request,
      ));
    },

    async updateUserState(chatId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const request = CanonicalUpdateChatUserStateRequestSchema.parse(input);
      return CanonicalChatRecordSchema.parse(await api.patch(
        `/api/chats/${encodeURIComponent(parsedChatId)}/user-state`,
        request,
      ));
    },

    async acknowledgeCompletion(chatId, runId) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const request = CanonicalAcknowledgeChatCompletionRequestSchema.parse({});
      return CanonicalChatRecordSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/runs/${encodeURIComponent(parsedRunId)}/acknowledge`,
        request,
      ));
    },

    async delete(chatId, clientRequestId) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const requestId = z.string().trim().min(1).max(128).parse(clientRequestId);
      return api.delete(withQuery(`/api/chats/${encodeURIComponent(parsedChatId)}`, {
        clientRequestId: requestId,
      }));
    },

    async getDetail(chatId, input = {}) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsed = CanonicalChatDetailInputSchema.parse(input);
      const response = await api.get(withQuery(`/api/chats/${encodeURIComponent(parsedChatId)}`, {
        limit: parsed.limit,
        cursor: parsed.cursor,
      }));
      return CanonicalChatDetailResponseSchema.parse(response);
    },

    async admitTurn(chatId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const request = CanonicalCreateChatTurnRequestSchema.parse(input);
      return CanonicalChatTurnAdmissionResponseSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/turns`,
        request,
      ));
    },

    async cancelRun(chatId, runId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const request = CanonicalCancelChatRunRequestSchema.parse(input);
      return CanonicalChatRunCancellationResponseSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/runs/${encodeURIComponent(parsedRunId)}/cancel`,
        request,
      ));
    },

    async submitApproval(chatId, runId, approvalId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const parsedApprovalId = z.string().trim().min(1).max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
        .parse(approvalId);
      const request = CanonicalSubmitChatApprovalRequestSchema.parse(input);
      return CanonicalChatApprovalSubmissionResponseSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/runs/${encodeURIComponent(parsedRunId)}/approvals/${encodeURIComponent(parsedApprovalId)}`,
        request,
      ));
    },

    async retryTurn(chatId, turnId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedTurnId = CanonicalChatTurnIdSchema.parse(turnId);
      const request = CanonicalRetryChatTurnRequestSchema.parse(input);
      return CanonicalChatRunAdmissionResponseSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/turns/${encodeURIComponent(parsedTurnId)}/runs`,
        request,
      ));
    },
  };
}
