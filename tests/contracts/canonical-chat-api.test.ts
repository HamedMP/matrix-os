import {
  CanonicalCancelChatRunRequestSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalChatRunAdmissionResponseSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalRetryChatTurnRequestSchema,
  CanonicalUpdateChatTitleRequestSchema,
  CanonicalUpdateChatUserStateRequestSchema,
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

const chatRecord = CanonicalChatRecordSchema.parse({ chat });
const userMessage = {
  id: "msg_turn_contract",
  chatId: chat.id,
  seq: 1,
  role: "user",
  state: "committed",
  turnId: "cturn_contract",
  parts: [{ type: "text", text: "implement it" }],
  createdAt: "2026-08-25T12:01:00.000Z",
} as const;
const turn = {
  id: "cturn_contract",
  chatId: chat.id,
  clientRequestId: "req_turn_contract",
  baseMessageSeq: 0,
  inputMessageId: userMessage.id,
  status: "accepted",
  createdAt: "2026-08-25T12:01:00.000Z",
  updatedAt: "2026-08-25T12:01:00.000Z",
} as const;
const run = {
  id: "run_contract",
  chatId: chat.id,
  turnId: turn.id,
  attempt: 1,
  driverKind: "codex",
  instanceId: "codex_default",
  selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
  interactionMode: "default",
  permissionMode: "supervised",
  status: "accepted",
  historyBoundarySeq: 0,
  capabilitySnapshot: {
    revision: "catalog_contract",
    rootChat: true,
    attachments: ["file"],
    resources: ["file", "folder", "project"],
    tools: [],
    approvals: true,
    userInput: true,
    resume: true,
    cancellation: true,
    worktrees: "optional",
    interactionModes: ["default"],
    permissionModes: ["supervised"],
  },
  createdAt: "2026-08-25T12:01:00.000Z",
  updatedAt: "2026-08-25T12:01:00.000Z",
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

  it("accepts only the requested durable per-user Chat state", () => {
    expect(CanonicalUpdateChatUserStateRequestSchema.parse({ pinned: true }))
      .toEqual({ pinned: true });
    expect(CanonicalUpdateChatUserStateRequestSchema.safeParse({
      pinned: true,
      ownerId: "other_owner",
    }).success).toBe(false);
  });

  it("accepts only bounded, non-empty revision-guarded Chat titles", () => {
    expect(CanonicalUpdateChatTitleRequestSchema.parse({
      baseRevision: 4,
      title: "  Release plan  ",
    })).toEqual({ baseRevision: 4, title: "Release plan" });
    expect(CanonicalUpdateChatTitleRequestSchema.safeParse({
      baseRevision: 4,
      title: "   ",
    }).success).toBe(false);
    expect(CanonicalUpdateChatTitleRequestSchema.safeParse({
      baseRevision: 4,
      title: "x".repeat(161),
    }).success).toBe(false);
    expect(CanonicalUpdateChatTitleRequestSchema.safeParse({
      baseRevision: 4,
      title: "Release plan",
      ownerId: "other_owner",
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
      terminalSessionIds: ["chat-draft-terminal"],
    })).toMatchObject({
      record: { chat: { id: "chat_api_test" } },
      terminalSessionIds: ["chat-draft-terminal"],
    });
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

  it("preserves the exact successful completion fact in canonical list and detail records", () => {
    const completion = {
      runId: "run_completed_exact",
      completedAt: "2026-08-25T12:02:00.000Z",
      unacknowledged: true,
    };
    const completedRecord = {
      ...chatRecord,
      latestSuccessfulCompletion: completion,
    };

    const list = CanonicalChatListResponseSchema.parse({ items: [completedRecord] });
    const detail = CanonicalChatDetailResponseSchema.parse({
      record: completedRecord,
      messages: [],
      turns: [],
      runs: [],
      activities: [],
    });

    expect(list.items[0]?.latestSuccessfulCompletion).toEqual(completion);
    expect(detail.record).toEqual(list.items[0]);
  });

  it("accepts only bounded user Turn input and keeps ownership and paths server-owned", () => {
    const request = {
      clientRequestId: "req_turn_contract",
      baseRevision: 2,
      parts: [
        { type: "text", text: "implement the canonical turn" },
        { type: "resource_reference", resource: { kind: "file", id: "file_readme", label: "README.md" } },
      ],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
      executionRoot: { kind: "project", projectId: "project_matrix" },
    };

    expect(CanonicalCreateChatTurnRequestSchema.parse(request)).toEqual(request);
    expect(CanonicalCreateChatTurnRequestSchema.safeParse({
      ...request,
      ownerScope: { type: "personal", ownerId: "other" },
    }).success).toBe(false);
    expect(CanonicalCreateChatTurnRequestSchema.safeParse({
      ...request,
      executionRoot: { kind: "project", projectId: "/home/matrix/private" },
    }).success).toBe(false);
    expect(CanonicalCreateChatTurnRequestSchema.safeParse({
      ...request,
      parts: [{ type: "tool_result", toolCallId: "tool_1", outcome: "success", truncated: false }],
    }).success).toBe(false);
  });

  it("defines strict admission and idempotent cancel envelopes", () => {
    const response = {
      record: chatRecord,
      message: userMessage,
      turn,
      run,
      admission: "accepted",
    };
    expect(CanonicalChatTurnAdmissionResponseSchema.parse(response)).toEqual(response);
    expect(CanonicalCancelChatRunRequestSchema.parse({ clientRequestId: "req_cancel_contract" }))
      .toEqual({ clientRequestId: "req_cancel_contract" });
    expect(CanonicalCancelChatRunRequestSchema.safeParse({
      clientRequestId: "req_cancel_contract",
      providerSessionId: "secret",
    }).success).toBe(false);

    expect(CanonicalRetryChatTurnRequestSchema.parse({
      clientRequestId: "req_retry_contract",
      baseRevision: 4,
    })).toEqual({ clientRequestId: "req_retry_contract", baseRevision: 4 });
    expect(CanonicalChatRunAdmissionResponseSchema.parse({
      record: chatRecord,
      turn,
      run: { ...run, attempt: 2 },
      admission: "accepted",
    })).toMatchObject({ run: { attempt: 2 } });
  });
});
