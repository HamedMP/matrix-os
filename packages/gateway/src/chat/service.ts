import { randomUUID } from "node:crypto";
import {
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatRunSteeringResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatQueueAdmissionResponseSchema,
  CanonicalChatQueueCancellationResponseSchema,
  CanonicalChatQueueReorderResponseSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalQueueChatTurnRequestSchema,
  CanonicalCancelQueuedChatTurnRequestSchema,
  CanonicalReorderQueuedChatTurnsRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  CanonicalSteerChatRunRequestSchema,
  CanonicalUpdateChatProjectRequestSchema,
  CanonicalUpdateChatUserStateRequestSchema,
  CanonicalCreateChatRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatRunSteeringResponse,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatQueueAdmissionResponse,
  type CanonicalChatQueueCancellationResponse,
  type CanonicalChatQueueReorderResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCancelChatRunRequest,
  type CanonicalCancelQueuedChatTurnRequest,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalQueueChatTurnRequest,
  type CanonicalReorderQueuedChatTurnsRequest,
  type CanonicalRetryChatTurnRequest,
  type CanonicalSubmitChatApprovalRequest,
  type CanonicalSteerChatRunRequest,
  type CanonicalChatApprovalSubmissionResponse,
  type CanonicalUpdateChatProjectRequest,
  type CanonicalUpdateChatUserStateRequest,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { CanonicalChatRouteService } from "./routes.js";
import type { RequestPrincipal } from "../request-principal.js";
import { ChatExecutionRootError, type ChatExecutionRootResolver } from "./execution-root.js";
import { CanonicalChatOrchestrationError, type CanonicalChatOrchestrator } from "./orchestrator.js";

const CursorEnvelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("list"),
    updatedAt: z.iso.datetime({ offset: true }),
    chatId: CanonicalChatIdSchema,
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("messages"),
    chatId: CanonicalChatIdSchema,
    beforeSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
]);

type CursorEnvelope = z.infer<typeof CursorEnvelopeSchema>;
type ChatServiceRepository = Pick<ChatRepository,
  | "create"
  | "update"
  | "updateUserState"
  | "acknowledgeCompletion"
  | "hardDelete"
  | "list"
  | "search"
  | "getDetailPage"
  | "cancelQueuedTurn"
  | "reorderQueuedTurns"
>;

function encodeCursor(value: CursorEnvelope): string {
  return CanonicalChatApiCursorSchema.parse(
    `chatcur_${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`,
  );
}

function decodeCursor(value: string): CursorEnvelope {
  const parsed = CanonicalChatApiCursorSchema.parse(value);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parsed.slice("chatcur_".length), "base64url").toString("utf8"));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    decoded = undefined;
  }
  return CursorEnvelopeSchema.parse(
    decoded,
  );
}

function decodeListCursor(value: string) {
  const cursor = decodeCursor(value);
  z.literal("list").parse(cursor.kind);
  if (cursor.kind !== "list") throw new Error("Invalid Chat list cursor");
  return { updatedAt: cursor.updatedAt, chatId: cursor.chatId };
}

function decodeMessageCursor(value: string, chatId: string): number {
  const cursor = decodeCursor(value);
  z.literal("messages").parse(cursor.kind);
  if (cursor.kind !== "messages") throw new Error("Invalid Chat message cursor");
  z.literal(chatId).parse(cursor.chatId);
  return cursor.beforeSeq;
}

export function createCanonicalChatService(
  repository: ChatServiceRepository,
  options: {
    orchestrator?: Pick<CanonicalChatOrchestrator,
      "admitTurn" | "enqueueQueuedTurn" | "steerRun" | "cancelRun" | "submitApproval" | "retryTurn"
    >;
    executionRoots?: Pick<ChatExecutionRootResolver, "resolve">;
  } = {},
): CanonicalChatRouteService {
  return {
    async create(owner: ChatOwner, input: CanonicalCreateChatRequest): Promise<CanonicalChatRecord> {
      const request = CanonicalCreateChatRequestSchema.parse(input);
      const created = await repository.create(owner, {
        id: CanonicalChatIdSchema.parse(`chat_${randomUUID().replaceAll("-", "")}`),
        clientRequestId: request.clientRequestId,
        title: request.title ?? "New chat",
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(request.currentSelection === undefined ? {} : { currentSelection: request.currentSelection }),
      });
      return CanonicalChatRecordSchema.parse(created);
    },

    async updateProject(
      owner: ChatOwner,
      chatId: string,
      input: CanonicalUpdateChatProjectRequest,
    ): Promise<CanonicalChatRecord> {
      const request = CanonicalUpdateChatProjectRequestSchema.parse(input);
      if (request.projectId !== null) {
        if (!options.executionRoots) {
          throw new CanonicalChatOrchestrationError(CanonicalChatSafeErrorSchema.parse({
            code: "project_unavailable",
            safeMessage: "The Project workspace is unavailable.",
            retryable: true,
            recoveryActions: ["retry"],
          }), 503);
        }
        try {
          await options.executionRoots.resolve(owner, {
            kind: "project",
            projectId: request.projectId,
          });
        } catch (error: unknown) {
          if (!(error instanceof ChatExecutionRootError)) throw error;
          const retryable = error.code === "validation_unavailable";
          throw new CanonicalChatOrchestrationError(CanonicalChatSafeErrorSchema.parse({
            code: "project_unavailable",
            safeMessage: "The Project workspace is unavailable.",
            retryable,
            ...(retryable ? { recoveryActions: ["retry"] as const } : {}),
          }), retryable ? 503 : 409);
        }
      }
      return CanonicalChatRecordSchema.parse(await repository.update(
        owner,
        CanonicalChatIdSchema.parse(chatId),
        request,
      ));
    },

    async updateUserState(
      owner: ChatOwner,
      chatId: string,
      input: CanonicalUpdateChatUserStateRequest,
    ): Promise<CanonicalChatRecord> {
      return CanonicalChatRecordSchema.parse(await repository.updateUserState(
        owner,
        CanonicalChatIdSchema.parse(chatId),
        CanonicalUpdateChatUserStateRequestSchema.parse(input),
      ));
    },

    async acknowledgeCompletion(owner, chatId, runId): Promise<CanonicalChatRecord> {
      return CanonicalChatRecordSchema.parse(await repository.acknowledgeCompletion(
        owner,
        CanonicalChatIdSchema.parse(chatId),
        CanonicalChatRunIdSchema.parse(runId),
      ));
    },

    async delete(owner, chatId, clientRequestId) {
      return repository.hardDelete(owner, {
        chatId: CanonicalChatIdSchema.parse(chatId),
        clientRequestId: z.string().trim().min(1).max(128).parse(clientRequestId),
      });
    },

    async list(owner, input): Promise<CanonicalChatListResponse> {
      const page = await repository.list(owner, {
        limit: input.limit,
        ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.cursor === undefined ? {} : { cursor: decodeListCursor(input.cursor) }),
      });
      return CanonicalChatListResponseSchema.parse({
        items: page.items,
        ...(page.nextCursor === undefined ? {} : {
          nextCursor: encodeCursor({
            version: 1,
            kind: "list",
            updatedAt: page.nextCursor.updatedAt,
            chatId: page.nextCursor.chatId,
          }),
        }),
      });
    },

    async search(owner, input): Promise<CanonicalChatListResponse> {
      return CanonicalChatListResponseSchema.parse({
        items: await repository.search(
          owner,
          input.query,
          input.limit,
          input.projectId,
        ),
      });
    },

    async getDetail(owner, chatId, input): Promise<CanonicalChatDetailResponse | null> {
      const parsedChatId = CanonicalChatIdSchema.parse(chatId);
      const page = await repository.getDetailPage(owner, parsedChatId, {
        limit: input.limit,
        ...(input.cursor === undefined ? {} : {
          beforeSeq: decodeMessageCursor(input.cursor, parsedChatId),
        }),
      });
      if (!page) return null;
      return CanonicalChatDetailResponseSchema.parse({
        record: page.record,
        messages: page.messages,
        turns: page.turns,
        runs: page.runs,
        activities: page.activities,
        queuedTurns: page.queuedTurns,
        terminalSessionIds: page.terminalSessionIds,
        ...(page.nextBeforeSeq === undefined ? {} : {
          nextCursor: encodeCursor({
            version: 1,
            kind: "messages",
            chatId: parsedChatId,
            beforeSeq: page.nextBeforeSeq,
          }),
        }),
      });
    },

    async admitTurn(
      principal: RequestPrincipal,
      owner: ChatOwner,
      chatId: string,
      input: CanonicalCreateChatTurnRequest,
    ): Promise<CanonicalChatTurnAdmissionResponse> {
      if (!options.orchestrator) throw new Error("Canonical Chat orchestration unavailable");
      return CanonicalChatTurnAdmissionResponseSchema.parse(await options.orchestrator.admitTurn(
        principal,
        owner,
        CanonicalChatIdSchema.parse(chatId),
        CanonicalCreateChatTurnRequestSchema.parse(input),
      ));
    },

    async enqueueQueuedTurn(
      principal: RequestPrincipal,
      owner: ChatOwner,
      chatId: string,
      input: CanonicalQueueChatTurnRequest,
    ): Promise<CanonicalChatQueueAdmissionResponse> {
      if (!options.orchestrator) throw new Error("Canonical Chat orchestration unavailable");
      return CanonicalChatQueueAdmissionResponseSchema.parse(
        await options.orchestrator.enqueueQueuedTurn(
          principal,
          owner,
          CanonicalChatIdSchema.parse(chatId),
          CanonicalQueueChatTurnRequestSchema.parse(input),
        ),
      );
    },

    async cancelQueuedTurn(
      owner: ChatOwner,
      chatId: string,
      queuedTurnId: string,
      input: CanonicalCancelQueuedChatTurnRequest,
    ): Promise<CanonicalChatQueueCancellationResponse> {
      const request = CanonicalCancelQueuedChatTurnRequestSchema.parse(input);
      return CanonicalChatQueueCancellationResponseSchema.parse(
        await repository.cancelQueuedTurn(owner, {
          chatId: CanonicalChatIdSchema.parse(chatId),
          queuedTurnId,
          clientRequestId: request.clientRequestId,
          baseRevision: request.baseRevision,
          cancelledAt: new Date().toISOString(),
        }),
      );
    },

    async reorderQueuedTurns(
      owner: ChatOwner,
      chatId: string,
      input: CanonicalReorderQueuedChatTurnsRequest,
    ): Promise<CanonicalChatQueueReorderResponse> {
      const request = CanonicalReorderQueuedChatTurnsRequestSchema.parse(input);
      return CanonicalChatQueueReorderResponseSchema.parse(
        await repository.reorderQueuedTurns(owner, {
          chatId: CanonicalChatIdSchema.parse(chatId),
          clientRequestId: request.clientRequestId,
          baseRevision: request.baseRevision,
          queuedTurnIds: request.queuedTurnIds,
          reorderedAt: new Date().toISOString(),
        }),
      );
    },

    async cancelRun(
      owner: ChatOwner,
      chatId: string,
      runId: string,
      _input: CanonicalCancelChatRunRequest,
    ): Promise<CanonicalChatRunCancellationResponse> {
      if (!options.orchestrator) throw new Error("Canonical Chat orchestration unavailable");
      return CanonicalChatRunCancellationResponseSchema.parse(
        await options.orchestrator.cancelRun(owner, CanonicalChatIdSchema.parse(chatId), runId),
      );
    },

    async steerRun(
      owner: ChatOwner,
      chatId: string,
      runId: string,
      input: CanonicalSteerChatRunRequest,
    ): Promise<CanonicalChatRunSteeringResponse> {
      if (!options.orchestrator) throw new Error("Canonical Chat orchestration unavailable");
      return CanonicalChatRunSteeringResponseSchema.parse(await options.orchestrator.steerRun(
        owner,
        CanonicalChatIdSchema.parse(chatId),
        CanonicalChatRunIdSchema.parse(runId),
        CanonicalSteerChatRunRequestSchema.parse(input),
      ));
    },

    async submitApproval(
      owner: ChatOwner,
      chatId: string,
      runId: string,
      approvalId: string,
      input: CanonicalSubmitChatApprovalRequest,
    ): Promise<CanonicalChatApprovalSubmissionResponse> {
      if (!options.orchestrator) throw new Error("Canonical Chat orchestration unavailable");
      return options.orchestrator.submitApproval(
        owner,
        CanonicalChatIdSchema.parse(chatId),
        runId,
        approvalId,
        CanonicalSubmitChatApprovalRequestSchema.parse(input),
      );
    },

    async retryTurn(
      principal: RequestPrincipal,
      owner: ChatOwner,
      chatId: string,
      turnId: string,
      input: CanonicalRetryChatTurnRequest,
    ): Promise<CanonicalChatRunAdmissionResponse> {
      if (!options.orchestrator) throw new Error("Canonical Chat orchestration unavailable");
      return CanonicalChatRunAdmissionResponseSchema.parse(await options.orchestrator.retryTurn(
        principal,
        owner,
        CanonicalChatIdSchema.parse(chatId),
        turnId,
        CanonicalRetryChatTurnRequestSchema.parse(input),
      ));
    },
  };
}

export function createUnavailableCanonicalChatService(): CanonicalChatRouteService {
  const unavailable = async (): Promise<never> => {
    const error = new Error("Canonical Chat repository unavailable");
    error.name = "CanonicalChatServiceUnavailableError";
    throw error;
  };
  return {
    create: unavailable,
    updateProject: unavailable,
    updateUserState: unavailable,
    acknowledgeCompletion: unavailable,
    delete: unavailable,
    list: unavailable,
    search: unavailable,
    getDetail: unavailable,
    admitTurn: unavailable,
    enqueueQueuedTurn: unavailable,
    cancelQueuedTurn: unavailable,
    reorderQueuedTurns: unavailable,
    steerRun: unavailable,
    cancelRun: unavailable,
    submitApproval: unavailable,
    retryTurn: unavailable,
  };
}
