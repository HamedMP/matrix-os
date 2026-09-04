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
export { createSharedCanonicalChatEventSource as createCanonicalChatEventSource } from "@matrix-os/ui";
export type {
  CanonicalChatEventConnectionState,
  CanonicalChatEventConsumer,
  CanonicalChatEventSource,
  CanonicalChatInvalidation,
} from "@matrix-os/ui";
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
