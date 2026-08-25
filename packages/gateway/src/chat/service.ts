import { randomUUID } from "node:crypto";
import {
  CanonicalChatApiCursorSchema,
  CanonicalChatDetailResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalCreateChatRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatRecord,
  type CanonicalCreateChatRequest,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { CanonicalChatRouteService } from "./routes.js";

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
type ChatServiceRepository = Pick<ChatRepository, "create" | "list" | "getDetailPage">;

function encodeCursor(value: CursorEnvelope): string {
  return CanonicalChatApiCursorSchema.parse(
    `chatcur_${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`,
  );
}

function decodeCursor(value: string): CursorEnvelope {
  const parsed = CanonicalChatApiCursorSchema.parse(value);
  return CursorEnvelopeSchema.parse(
    JSON.parse(Buffer.from(parsed.slice("chatcur_".length), "base64url").toString("utf8")),
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

export function createCanonicalChatService(repository: ChatServiceRepository): CanonicalChatRouteService {
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
    list: unavailable,
    getDetail: unavailable,
  };
}
