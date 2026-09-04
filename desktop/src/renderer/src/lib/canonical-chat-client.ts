import {
  CanonicalAcknowledgeChatCompletionRequestSchema,
  CanonicalCancelChatRunRequestSchema,
  CanonicalCancelQueuedChatTurnRequestSchema,
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatQueueAdmissionResponseSchema,
  CanonicalChatQueueCancellationResponseSchema,
  CanonicalChatQueueReorderResponseSchema,
  CanonicalChatQueueUpdateResponseSchema,
  CanonicalChatQueuedTurnIdSchema,
  CanonicalChatRunSteeringResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatStreamServerFrameSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatTurnIdSchema,
  CanonicalCreateChatRequestSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalQueueChatTurnRequestSchema,
  CanonicalReorderQueuedChatTurnsRequestSchema,
  CanonicalUpdateQueuedChatTurnRequestSchema,
  CanonicalSteerQueuedChatTurnRequestSchema,
  CanonicalSteerChatRunRequestSchema,
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
  type CanonicalChatQueueAdmissionResponse,
  type CanonicalChatQueueCancellationResponse,
  type CanonicalChatQueueReorderResponse,
  type CanonicalChatQueueUpdateResponse,
  type CanonicalChatRunSteeringResponse,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCancelChatRunRequest,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalQueueChatTurnRequest,
  type CanonicalCancelQueuedChatTurnRequest,
  type CanonicalReorderQueuedChatTurnsRequest,
  type CanonicalUpdateQueuedChatTurnRequest,
  type CanonicalSteerQueuedChatTurnRequest,
  type CanonicalSteerChatRunRequest,
  type CanonicalSubmitChatApprovalRequest,
  type CanonicalRetryChatTurnRequest,
  type CanonicalUpdateChatProjectRequest,
  type CanonicalUpdateChatUserStateRequest,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ApiClient } from "./api";
import { AppError } from "../../../shared/app-error";
import {
  trackDesktopEvent,
  type DesktopAnalyticsDetail,
} from "./desktop-analytics";
import {
  desktopChatModelProvider,
  type CanonicalChatResponseAnalytics,
} from "./canonical-chat-analytics";

export type { CanonicalChatResponseAnalytics } from "./canonical-chat-analytics";

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
const DEFAULT_CHAT_EVENT_HEARTBEAT_MS = 10_000;
const MAX_CHAT_EVENT_HEARTBEAT_MS = 60_000;
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
  heartbeatIntervalMs?: number;
  setIntervalFn?: (callback: () => void, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
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
  const heartbeatIntervalMs = Math.max(1_000, Math.min(
    options.heartbeatIntervalMs ?? DEFAULT_CHAT_EVENT_HEARTBEAT_MS,
    MAX_CHAT_EVENT_HEARTBEAT_MS,
  ));
  const setIntervalFn = options.setIntervalFn ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const clearIntervalFn = options.clearIntervalFn
    ?? ((timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>));
  let socket: DesktopCanonicalChatWebSocket | null = null;
  let reconnectTimer: unknown;
  let heartbeatTimer: unknown;
  let awaitingHeartbeatPong = false;
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

  const clearHeartbeat = () => {
    awaitingHeartbeatPong = false;
    if (heartbeatTimer === undefined) return;
    clearIntervalFn(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== undefined) return;
    setConnectionState("reconnecting");
    const delay = Math.min(250 * (2 ** reconnectAttempt), maxReconnectDelayMs);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  }

  const closeHeartbeatSocket = (target: DesktopCanonicalChatWebSocket) => {
    clearHeartbeat();
    try {
      target.close();
    } catch (error: unknown) {
      console.warn(
        "[canonical-chat] event socket close failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    scheduleReconnect();
  };

  const startHeartbeat = (target: DesktopCanonicalChatWebSocket) => {
    clearHeartbeat();
    heartbeatTimer = setIntervalFn(() => {
      if (disposed || socket !== target || target.readyState !== 1) return;
      if (awaitingHeartbeatPong) {
        console.warn("[canonical-chat] event stream heartbeat timed out");
        closeHeartbeatSocket(target);
        return;
      }
      try {
        target.send(JSON.stringify({ type: "ping" }));
        awaitingHeartbeatPong = true;
      } catch (error: unknown) {
        console.warn(
          "[canonical-chat] event stream heartbeat failed:",
          error instanceof Error ? error.name : "UnknownError",
        );
        closeHeartbeatSocket(target);
      }
    }, heartbeatIntervalMs);
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
    let replayComplete = false;
    let replaySawEvent = false;
    replayGap = false;
    socket = nextSocket;
    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      reconnectAttempt = 0;
      startHeartbeat(nextSocket);
    };
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
      awaitingHeartbeatPong = false;
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
        if (replayGap || replaySawEvent) {
          emit({
            type: "chat.full_refresh",
            ...(frame.nextCursor === undefined ? {} : { cursor: frame.nextCursor }),
          });
        }
        replayComplete = true;
        replayGap = false;
        return;
      }
      if (frame.type === "chat.event") {
        lastCursor = frame.event.cursor;
        if (!rememberCursor(frame.event.cursor)) return;
        if (!replayComplete) replaySawEvent = true;
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
      clearHeartbeat();
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
      clearHeartbeat();
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
  acknowledgeCompletion(
    chatId: string,
    runId: string,
    analytics?: CanonicalChatResponseAnalytics,
  ): Promise<CanonicalChatRecord>;
  delete(chatId: string, clientRequestId: string): Promise<{ chatId: string; deletedAt: string }>;
  getDetail(
    chatId: string,
    input?: z.input<typeof CanonicalChatDetailInputSchema>,
  ): Promise<CanonicalChatDetailResponse>;
  admitTurn(
    chatId: string,
    input: CanonicalCreateChatTurnRequest,
    analytics?: { chatScope: "global" | "project" },
  ): Promise<CanonicalChatTurnAdmissionResponse>;
  queueTurn(chatId: string, input: CanonicalQueueChatTurnRequest): Promise<CanonicalChatQueueAdmissionResponse>;
  steerRun(
    chatId: string,
    runId: string,
    input: CanonicalSteerChatRunRequest,
  ): Promise<CanonicalChatRunSteeringResponse>;
  steerQueuedTurn(
    chatId: string,
    runId: string,
    queuedTurnId: string,
    input: CanonicalSteerQueuedChatTurnRequest,
  ): Promise<CanonicalChatRunSteeringResponse>;
  updateQueuedTurn(
    chatId: string,
    queuedTurnId: string,
    input: CanonicalUpdateQueuedChatTurnRequest,
  ): Promise<CanonicalChatQueueUpdateResponse>;
  cancelQueuedTurn(
    chatId: string,
    queuedTurnId: string,
    input: CanonicalCancelQueuedChatTurnRequest,
  ): Promise<CanonicalChatQueueCancellationResponse>;
  reorderQueuedTurns(
    chatId: string,
    input: CanonicalReorderQueuedChatTurnsRequest,
  ): Promise<CanonicalChatQueueReorderResponse>;
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
  options: {
    trackEvent?: (detail: DesktopAnalyticsDetail) => unknown;
  } = {},
): CanonicalChatClient {
  const trackEvent = options.trackEvent ?? trackDesktopEvent;
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

    async acknowledgeCompletion(chatId, runId, analytics) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const request = CanonicalAcknowledgeChatCompletionRequestSchema.parse({});
      const response = CanonicalChatRecordSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/runs/${encodeURIComponent(parsedRunId)}/acknowledge`,
        request,
      ));
      if (analytics) {
        trackEvent({
          name: "desktop_chat_response_completed",
          chatScope: analytics.chatScope,
          harness: analytics.harness,
          modelProvider: desktopChatModelProvider(analytics.model, analytics.harness),
          model: analytics.model,
          responseCharacterCount: analytics.responseCharacterCount,
        });
      }
      return response;
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

    async admitTurn(chatId, input, analytics) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const request = CanonicalCreateChatTurnRequestSchema.parse(input);
      const hasAttachments = request.parts.some((part) => (
        part.type === "attachment_reference" || part.type === "resource_reference"
      ));
      if (analytics) {
        trackEvent({
          name: "desktop_chat_message_send_attempted",
          chatScope: analytics.chatScope,
          hasAttachments,
        });
      }
      try {
        const response = CanonicalChatTurnAdmissionResponseSchema.parse(await api.post(
          `/api/chats/${encodeURIComponent(parsedChatId)}/turns`,
          request,
        ));
        if (analytics) {
          trackEvent({
            name: "desktop_chat_message_send_succeeded",
            chatScope: analytics.chatScope,
            hasAttachments,
            harness: response.run.driverKind,
            modelProvider: desktopChatModelProvider(response.run.selection.model, response.run.driverKind),
            model: response.run.selection.model,
          });
        }
        return response;
      } catch (error: unknown) {
        if (analytics) {
          const failureKind = error instanceof AppError
            ? error.category === "offline" || error.category === "timeout"
              ? "network"
              : error.category === "unauthorized" || error.category === "notFound"
                ? "client"
                : "server"
            : "unknown";
          trackEvent({
            name: "desktop_chat_message_send_failed",
            chatScope: analytics.chatScope,
            hasAttachments,
            failureKind,
          });
        }
        throw error;
      }
    },

    async queueTurn(chatId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const request = CanonicalQueueChatTurnRequestSchema.parse(input);
      return CanonicalChatQueueAdmissionResponseSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/queued-turns`,
        request,
      ));
    },

    async steerRun(chatId, runId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const request = CanonicalSteerChatRunRequestSchema.parse(input);
      return CanonicalChatRunSteeringResponseSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/runs/${encodeURIComponent(parsedRunId)}/steer`,
        request,
      ));
    },

    async steerQueuedTurn(chatId, runId, queuedTurnId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const parsedQueuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(queuedTurnId);
      const request = CanonicalSteerQueuedChatTurnRequestSchema.parse(input);
      return CanonicalChatRunSteeringResponseSchema.parse(await api.post(
        `/api/chats/${encodeURIComponent(parsedChatId)}/runs/${encodeURIComponent(parsedRunId)}/queued-turns/${encodeURIComponent(parsedQueuedTurnId)}/steer`,
        request,
      ));
    },

    async updateQueuedTurn(chatId, queuedTurnId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedQueuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(queuedTurnId);
      const request = CanonicalUpdateQueuedChatTurnRequestSchema.parse(input);
      return CanonicalChatQueueUpdateResponseSchema.parse(await api.patch(
        `/api/chats/${encodeURIComponent(parsedChatId)}/queued-turns/${encodeURIComponent(parsedQueuedTurnId)}`,
        request,
      ));
    },

    async cancelQueuedTurn(chatId, queuedTurnId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const parsedQueuedTurnId = CanonicalChatQueuedTurnIdSchema.parse(queuedTurnId);
      const request = CanonicalCancelQueuedChatTurnRequestSchema.parse(input);
      return CanonicalChatQueueCancellationResponseSchema.parse(await api.delete(
        `/api/chats/${encodeURIComponent(parsedChatId)}/queued-turns/${encodeURIComponent(parsedQueuedTurnId)}`,
        request,
      ));
    },

    async reorderQueuedTurns(chatId, input) {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const request = CanonicalReorderQueuedChatTurnsRequestSchema.parse(input);
      return CanonicalChatQueueReorderResponseSchema.parse(await api.patch(
        `/api/chats/${encodeURIComponent(parsedChatId)}/queued-turns/order`,
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
