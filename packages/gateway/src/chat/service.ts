import { randomUUID } from "node:crypto";
import {
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalChatSafeErrorSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatTurnIdSchema,
  CanonicalChatTurnChangeSummaryResponseSchema,
  CanonicalChatTurnDiffResponseSchema,
  CanonicalChatTurnFileReadQuerySchema,
  CanonicalChatTurnFileReadResponseSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  CanonicalUpdateChatProjectRequestSchema,
  CanonicalCreateChatRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatRunAdmissionResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalChatTurnChangeSummaryResponse,
  type CanonicalChatTurnDiffResponse,
  type CanonicalChatTurnFileReadQuery,
  type CanonicalChatTurnFileReadResponse,
  type CanonicalCancelChatRunRequest,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
  type CanonicalRetryChatTurnRequest,
  type CanonicalUpdateChatProjectRequest,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { CanonicalChatRouteService } from "./routes.js";
import type { RequestPrincipal } from "../request-principal.js";
import { ChatExecutionRootError, type ChatExecutionRootResolver } from "./execution-root.js";
import { CanonicalChatOrchestrationError, type CanonicalChatOrchestrator } from "./orchestrator.js";
import {
  ChatTurnChangeCaptureError,
  type ChatTurnChangeCapture,
} from "./turn-changes.js";

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
type ChatServiceRepository = Pick<ChatRepository, "create" | "update" | "hardDelete" | "list" | "search" | "getDetailPage" | "getTurnChanges">;

function turnChangeUnavailable(error: unknown): never {
  if (error instanceof ChatExecutionRootError || error instanceof ChatTurnChangeCaptureError) {
    const retryable = error instanceof ChatExecutionRootError && error.code === "validation_unavailable"
      || error instanceof ChatTurnChangeCaptureError && error.code === "capture_unavailable";
    throw new CanonicalChatOrchestrationError(CanonicalChatSafeErrorSchema.parse({
      code: "resource_unavailable",
      safeMessage: "The requested Chat change is unavailable.",
      retryable,
      ...(retryable ? { recoveryActions: ["retry"] as const } : {}),
    }), retryable ? 503 : 404);
  }
  throw error;
}

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
    orchestrator?: Pick<CanonicalChatOrchestrator, "admitTurn" | "cancelRun" | "retryTurn">;
    executionRoots?: Pick<ChatExecutionRootResolver, "resolve" | "revalidate">;
    turnChanges?: Pick<ChatTurnChangeCapture, "readDiff" | "readFile">;
  } = {},
): CanonicalChatRouteService {
  const resolveStoredChanges = async (owner: ChatOwner, chatId: string, turnId: string) => {
    const stored = await repository.getTurnChanges(
      owner,
      CanonicalChatIdSchema.parse(chatId),
      CanonicalChatTurnIdSchema.parse(turnId),
    );
    if (!stored) return null;
    if (!options.executionRoots || !options.turnChanges) {
      return turnChangeUnavailable(new ChatTurnChangeCaptureError("capture_unavailable"));
    }
    try {
      const resolved = await options.executionRoots.revalidate(owner, {
        ref: stored.changes.executionRoot,
        fingerprint: stored.executionRootFingerprint,
      });
      return {
        stored,
        root: resolved.primaryWorkspaceRoot,
        start: { tree: stored.beforeTree, head: stored.beforeHead },
        end: { tree: stored.afterTree, head: stored.afterHead },
      };
    } catch (error: unknown) {
      return turnChangeUnavailable(error);
    }
  };

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

    async getTurnChanges(
      owner: ChatOwner,
      chatId: string,
      turnId: string,
    ): Promise<CanonicalChatTurnChangeSummaryResponse | null> {
      const stored = await repository.getTurnChanges(
        owner,
        CanonicalChatIdSchema.parse(chatId),
        CanonicalChatTurnIdSchema.parse(turnId),
      );
      return stored ? CanonicalChatTurnChangeSummaryResponseSchema.parse({ changes: stored.changes }) : null;
    },

    async getTurnDiff(
      owner: ChatOwner,
      chatId: string,
      turnId: string,
      path: string,
    ): Promise<CanonicalChatTurnDiffResponse | null> {
      const resolved = await resolveStoredChanges(owner, chatId, turnId);
      if (!resolved) return null;
      const parsedPath = CanonicalChatTurnFileReadQuerySchema.shape.path.parse(path);
      const file = resolved.stored.changes.files.find((entry) => entry.path === parsedPath);
      if (!file) return null;
      try {
        return CanonicalChatTurnDiffResponseSchema.parse({
          chatId: resolved.stored.changes.chatId,
          turnId: resolved.stored.changes.turnId,
          revision: resolved.stored.changes.revision,
          file: await options.turnChanges!.readDiff({
            root: resolved.root,
            path: parsedPath,
            start: resolved.start,
            end: resolved.end,
            file,
          }),
        });
      } catch (error: unknown) {
        return turnChangeUnavailable(error);
      }
    },

    async readTurnFile(
      owner: ChatOwner,
      chatId: string,
      turnId: string,
      input: CanonicalChatTurnFileReadQuery,
    ): Promise<CanonicalChatTurnFileReadResponse | null> {
      const resolved = await resolveStoredChanges(owner, chatId, turnId);
      if (!resolved) return null;
      const request = CanonicalChatTurnFileReadQuerySchema.parse(input);
      if (!resolved.stored.changes.files.some((entry) => entry.path === request.path || entry.previousPath === request.path)) {
        return null;
      }
      try {
        return CanonicalChatTurnFileReadResponseSchema.parse({
          chatId: resolved.stored.changes.chatId,
          turnId: resolved.stored.changes.turnId,
          revision: resolved.stored.changes.revision,
          ...await options.turnChanges!.readFile({
            root: resolved.root,
            path: request.path,
            version: request.version,
            start: resolved.start,
            end: resolved.end,
          }),
        });
      } catch (error: unknown) {
        return turnChangeUnavailable(error);
      }
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
    delete: unavailable,
    list: unavailable,
    search: unavailable,
    getDetail: unavailable,
    getTurnChanges: unavailable,
    getTurnDiff: unavailable,
    readTurnFile: unavailable,
    admitTurn: unavailable,
    cancelRun: unavailable,
    retryTurn: unavailable,
  };
}
