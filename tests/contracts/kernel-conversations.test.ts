import { describe, expect, it } from "vitest";
import {
  KernelConversationHistoryQuerySchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
} from "../../packages/contracts/src/index.js";

describe("kernel conversation contracts", () => {
  it("accepts bounded Matrix conversation identifiers", () => {
    expect(KernelConversationIdSchema.parse("mobile:123e4567-e89b-12d3-a456-426614174000"))
      .toBe("mobile:123e4567-e89b-12d3-a456-426614174000");
    expect(KernelConversationIdSchema.safeParse("../system/config").success).toBe(false);
    expect(KernelConversationIdSchema.safeParse("chat/other").success).toBe(false);
  });

  it("coerces and bounds history pagination", () => {
    expect(KernelConversationHistoryQuerySchema.parse({ limit: "25", cursor: "40" }))
      .toEqual({ limit: 25, cursor: 40 });
    expect(KernelConversationHistoryQuerySchema.parse({ cursor: "1000001" }))
      .toEqual({ limit: 50, cursor: 1_000_001 });
    expect(KernelConversationHistoryQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(KernelConversationHistoryQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(KernelConversationHistoryQuerySchema.safeParse({ cursor: "0" }).success).toBe(false);
    expect(KernelConversationHistoryQuerySchema.safeParse({ extra: "value" }).success).toBe(false);
  });

  it("rejects unbounded or secret-bearing history payload fields", () => {
    const valid = {
      id: "conversation-1",
      createdAt: 1,
      updatedAt: 2,
      totalCount: 1,
      messages: [{
        index: 0,
        role: "assistant",
        content: "Done",
        contentTruncated: false,
        timestamp: 2,
        tool: "Read",
      }],
      hasMore: false,
      limit: 50,
    };

    expect(KernelConversationHistoryResponseSchema.parse(valid)).toEqual(valid);
    expect(KernelConversationHistoryResponseSchema.parse({
      ...valid,
      totalCount: 1_000_001,
      messages: [{ ...valid.messages[0], index: 1_000_001 }],
      hasMore: true,
      nextCursor: "1000001",
    })).toMatchObject({ totalCount: 1_000_001, nextCursor: "1000001" });
    expect(KernelConversationHistoryResponseSchema.safeParse({
      ...valid,
      messages: [{ ...valid.messages[0], toolInput: { token: "secret" } }],
    }).success).toBe(false);
    expect(KernelConversationHistoryResponseSchema.safeParse({
      ...valid,
      messages: [{ ...valid.messages[0], content: "x".repeat(32_001) }],
    }).success).toBe(false);
  });
});
