import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalCreateChatRequestSchema,
} from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";

const chat = {
  id: "chat_api_test",
  ownerScope: { type: "personal", ownerId: "owner_1" },
  title: "API test",
  lifecycle: "active",
  attention: "none",
  revision: 0,
  messageCount: 0,
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
} as const;

describe("canonical Chat API contracts", () => {
  it("accepts bounded create requests without client-controlled ownership or Chat ids", () => {
    expect(CanonicalCreateChatRequestSchema.parse({
      clientRequestId: "req_create_api_test",
      title: "API test",
      projectId: "project_1",
      currentSelection: {
        instanceId: "codex_default",
        model: "gpt-5.6-sol",
      },
    })).toMatchObject({ projectId: "project_1" });

    expect(CanonicalCreateChatRequestSchema.safeParse({
      clientRequestId: "req_create_api_test",
      title: "API test",
      ownerScope: { type: "personal", ownerId: "other_owner" },
    }).success).toBe(false);
    expect(CanonicalCreateChatRequestSchema.safeParse({
      clientRequestId: "req_create_api_test",
      title: "API test",
      id: "chat_client_chosen",
    }).success).toBe(false);
  });

  it("bounds list and detail projections for shared clients", () => {
    const record = CanonicalChatRecordSchema.parse({ chat, projectId: "project_1" });
    expect(CanonicalChatListResponseSchema.parse({
      items: [record],
      nextCursor: "chatcur_opaque",
    }).items).toHaveLength(1);
    expect(CanonicalChatListResponseSchema.safeParse({
      items: Array.from({ length: 101 }, () => record),
    }).success).toBe(false);
    expect(CanonicalChatDetailResponseSchema.parse({
      record,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    }).record.chat.id).toBe("chat_api_test");
    expect(CanonicalChatDetailResponseSchema.safeParse({
      record,
      messages: Array.from({ length: 201 }, (_, index) => ({
        id: `msg_${index}`,
        chatId: chat.id,
        seq: index + 1,
        role: "assistant",
        state: "committed",
        parts: [{ type: "text", text: `message ${index}` }],
        createdAt: "2026-08-25T12:00:00.000Z",
      })),
      turns: [],
      runs: [],
      activities: [],
    }).success).toBe(false);
  });
});
