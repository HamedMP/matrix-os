import {
  CanonicalCancelChatRunRequestSchema,
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatTurnIdSchema,
  CanonicalCreateChatRequestSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  CanonicalUpdateChatProjectRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCancelChatRunRequest,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalRetryChatTurnRequest,
  type CanonicalUpdateChatProjectRequest,
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

export interface CanonicalChatClient {
  list(input?: z.input<typeof CanonicalChatListInputSchema>): Promise<CanonicalChatListResponse>;
  search(
    query: string,
    input?: z.input<typeof CanonicalChatSearchInputSchema>,
  ): Promise<CanonicalChatListResponse>;
  create(input: CanonicalCreateChatRequest): Promise<CanonicalChatRecord>;
  updateProject(chatId: string, input: CanonicalUpdateChatProjectRequest): Promise<CanonicalChatRecord>;
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
