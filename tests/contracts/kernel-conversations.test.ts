import { describe, expect, it } from "vitest";
import {
  KernelConversationContextProjectionSchema,
  KernelConversationContextUpdateSchema,
  KernelConversationDeleteResponseSchema,
  KernelConversationHistoryQuerySchema,
  KernelConversationHistoryResponseSchema,
  KernelConversationIdSchema,
  KernelConversationMutationErrorCodeSchema,
  KernelConversationSummarySchema,
} from "../../packages/contracts/src/index.js";

describe("kernel conversation contracts", () => {
  it("strictly bounds canonical project context updates and safe projections", () => {
    expect(KernelConversationContextUpdateSchema.parse({ projectId: "matrix-os" }))
      .toEqual({ projectId: "matrix-os" });
    expect(KernelConversationContextUpdateSchema.parse({ projectId: null }))
      .toEqual({ projectId: null });
    expect(KernelConversationContextUpdateSchema.safeParse({
      projectId: "matrix-os",
      localPath: "/private/repository",
    }).success).toBe(false);

    const context = {
      projectId: "matrix-os",
      projectName: "Matrix OS",
      projectKind: "github",
      repositoryLabel: "FinnaAI/matrix-os",
      status: "ready",
    } as const;
    expect(KernelConversationContextProjectionSchema.parse(context)).toEqual(context);
    expect(KernelConversationContextProjectionSchema.safeParse({
      ...context,
      workingDirectory: "/private/repository",
    }).success).toBe(false);
  });

  it("includes only safe optional context in conversation summaries and history", () => {
    const context = {
      projectId: "matrix-os",
      projectName: "Matrix OS",
      projectKind: "github",
      repositoryLabel: "FinnaAI/matrix-os",
      status: "unavailable",
    } as const;
    const summary = {
      id: "conversation-1",
      preview: "Inspect the repository",
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
      context,
    };
    const history = {
      id: "conversation-1",
      createdAt: 1,
      updatedAt: 2,
      totalCount: 0,
      messages: [],
      hasMore: false,
      limit: 50,
      context,
    };

    expect(KernelConversationSummarySchema.parse(summary)).toEqual(summary);
    expect(KernelConversationHistoryResponseSchema.parse(history)).toEqual(history);
    expect(KernelConversationSummarySchema.safeParse({
      ...summary,
      context: { ...context, localPath: "/private/repository" },
    }).success).toBe(false);
  });

  it("accepts bounded Matrix conversation identifiers", () => {
    expect(KernelConversationIdSchema.parse("mobile:123e4567-e89b-12d3-a456-426614174000"))
      .toBe("mobile:123e4567-e89b-12d3-a456-426614174000");
    expect(KernelConversationIdSchema.safeParse("../system/config").success).toBe(false);
    expect(KernelConversationIdSchema.safeParse("chat/other").success).toBe(false);
  });

  it("bounds conversation deletion responses and client error codes", () => {
    expect(KernelConversationDeleteResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(KernelConversationDeleteResponseSchema.safeParse({ ok: true, path: "/private/chat" }).success)
      .toBe(false);
    expect(KernelConversationMutationErrorCodeSchema.safeParse("conversation_busy").success)
      .toBe(true);
    expect(KernelConversationMutationErrorCodeSchema.safeParse("/Users/name/private").success)
      .toBe(false);
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
